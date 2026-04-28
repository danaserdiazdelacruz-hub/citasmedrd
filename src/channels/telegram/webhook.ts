// src/channels/telegram/webhook.ts
// Handler del webhook de Telegram con:
//   - RESOLUCIÓN DE CANAL POR ID (no más "primer canal activo")
//     La URL del webhook es /webhook/telegram/:canalId. Esto permite
//     correctamente multi-tenant: cada bot apunta a su propia URL.
//   - IDEMPOTENCIA por update_id (Telegram reintenta y se duplican citas)
//   - Mutex por chat (1 update a la vez)
//   - Cola con tope (descarta excedentes)
//   - Timeout duro de mutex (libera lock si se cuelga)
//   - Deduplicación de clicks repetidos del mismo botón

import { handleIncoming } from "../../application/orchestrator.js";
import type { IncomingMessage } from "../core/types.js";
import { telegramAdapter } from "./adapter.js";
import { tenantsRepo } from "../../persistence/repositories/index.js";

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}


// ─── Idempotencia de update_id ──────────────────────────────────────
// LRU en memoria. Por instancia, se pierde en restarts. Telegram
// raramente reintenta más allá de unos minutos así que es suficiente
// hasta que escalemos horizontalmente (ahí va a Redis).

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;     // 10 min
const IDEMPOTENCY_MAX_ENTRIES = 2000;

const seenUpdates = new Map<string, number>(); // key=`${canalId}:${updateId}` → expiraEnTs

function yaProcesado(canalId: string, updateId: number): boolean {
  const key = `${canalId}:${updateId}`;
  const ahora = Date.now();
  // Limpiar expirados oportunísticamente
  if (seenUpdates.size > IDEMPOTENCY_MAX_ENTRIES) {
    for (const [k, exp] of seenUpdates) {
      if (exp < ahora) seenUpdates.delete(k);
    }
    // Si sigue lleno, descartamos los más viejos por insertion order
    while (seenUpdates.size > IDEMPOTENCY_MAX_ENTRIES) {
      const firstKey = seenUpdates.keys().next().value;
      if (firstKey === undefined) break;
      seenUpdates.delete(firstKey);
    }
  }

  const exp = seenUpdates.get(key);
  if (exp !== undefined && exp > ahora) return true;

  seenUpdates.set(key, ahora + IDEMPOTENCY_TTL_MS);
  return false;
}


// ─── Mutex por chat ──────────────────────────────────────────────────

const MUTEX_TIMEOUT_MS = 12000;
const MAX_QUEUE_PER_CHAT = 3;
const DEDUP_WINDOW_MS = 2000;

interface ChatLock {
  busy: boolean;
  queue: Array<() => Promise<void>>;
  lastButtonData?: string;
  lastButtonAt?: number;
  busyTimeout?: NodeJS.Timeout;
}

const locks = new Map<string, ChatLock>();

function getOrCreateLock(chatId: string): ChatLock {
  let l = locks.get(chatId);
  if (!l) {
    l = { busy: false, queue: [] };
    locks.set(chatId, l);
  }
  return l;
}

function enqueueForChat(chatId: string, op: () => Promise<void>): void {
  const lock = getOrCreateLock(chatId);

  if (lock.busy) {
    if (lock.queue.length >= MAX_QUEUE_PER_CHAT) {
      console.warn(`[mutex] chat=${chatId} cola llena (${lock.queue.length}), descartando update`);
      return;
    }
    lock.queue.push(op);
    return;
  }

  runWithLock(chatId, op);
}

function runWithLock(chatId: string, op: () => Promise<void>): void {
  const lock = getOrCreateLock(chatId);
  lock.busy = true;

  lock.busyTimeout = setTimeout(() => {
    console.error(`[mutex] chat=${chatId} timeout ${MUTEX_TIMEOUT_MS}ms, forzando release`);
    releaseLock(chatId);
  }, MUTEX_TIMEOUT_MS);

  op()
    .catch(err => {
      console.error(`[mutex] chat=${chatId} op falló:`, err);
    })
    .finally(() => {
      releaseLock(chatId);
    });
}

function releaseLock(chatId: string): void {
  const lock = locks.get(chatId);
  if (!lock) return;

  if (lock.busyTimeout) {
    clearTimeout(lock.busyTimeout);
    lock.busyTimeout = undefined;
  }

  const next = lock.queue.shift();
  if (next) {
    runWithLock(chatId, next);
    return;
  }

  lock.busy = false;

  // Conservamos la entrada un rato más para que la deduplicación de botones
  // siga funcionando aunque la cola esté vacía. Se limpia con la TTL del
  // last button.
  if (lock.lastButtonAt && Date.now() - lock.lastButtonAt > DEDUP_WINDOW_MS) {
    locks.delete(chatId);
  }
}

function esDuplicadoBoton(chatId: string, buttonData: string): boolean {
  const lock = getOrCreateLock(chatId);
  const ahora = Date.now();
  if (lock.lastButtonData === buttonData
      && lock.lastButtonAt
      && (ahora - lock.lastButtonAt) < DEDUP_WINDOW_MS) {
    return true;
  }
  lock.lastButtonData = buttonData;
  lock.lastButtonAt = ahora;
  return false;
}


// ─── Entry point ─────────────────────────────────────────────────────

/**
 * `canalId` viene del path de la URL: /webhook/telegram/:canalId
 * El index.ts lo extrae y se lo pasa.
 */
export async function handleTelegramUpdate(canalId: string, update: TelegramUpdate): Promise<void> {
  const updateId = update.update_id;

  if (yaProcesado(canalId, updateId)) {
    console.log(`[tg:${updateId}] update duplicado (idempotencia), descartando`);
    return;
  }

  console.log(`[tg:${updateId}] recibido (canal=${canalId.slice(0, 8)})`);

  // Identificar chat
  let chatId: string | undefined;
  if (update.message) {
    chatId = String(update.message.chat.id);
  } else if (update.callback_query) {
    const cq = update.callback_query;
    chatId = String(cq.message?.chat.id ?? cq.from.id);
  }

  if (!chatId) {
    console.warn(`[tg:${updateId}] update sin chat_id, descartando`);
    return;
  }

  // Deduplicación de botones repetidos
  if (update.callback_query?.data) {
    if (esDuplicadoBoton(chatId, update.callback_query.data)) {
      console.log(`[tg:${updateId}] click duplicado descartado: ${update.callback_query.data}`);
      void answerCallbackQuery(update.callback_query.id);
      return;
    }
  }

  enqueueForChat(chatId, () => procesarUpdate(updateId, canalId, chatId!, update));
}


async function procesarUpdate(
  updateId: number,
  canalId: string,
  chatId: string,
  update: TelegramUpdate,
): Promise<void> {
  // Resolver el canal por id (multi-tenant correcto)
  let resolved: { canal: { id: string; tenant_id: string } } | null = null;
  try {
    const r = await tenantsRepo.findCanalById(canalId);
    if (r) resolved = { canal: { id: r.canal.id, tenant_id: r.canal.tenant_id } };
  } catch (err) {
    console.error(`[tg:${updateId}] error resolviendo canal ${canalId}:`, err);
    return;
  }

  if (!resolved) {
    console.error(`[tg:${updateId}] canal ${canalId} no existe / no activo`);
    return;
  }

  // Construir IncomingMessage
  let incoming: IncomingMessage | null = null;
  try {
    if (update.message) {
      const m = update.message;
      const text = m.text ?? "";
      const cmdEntity = m.entities?.find(e => e.type === "bot_command" && e.offset === 0);
      if (cmdEntity) {
        // /Start, /START, /start@bot → todos quedan como "start" (lowercase, sin @bot)
        const cmd = text.slice(1, cmdEntity.length).split("@")[0].toLowerCase();
        incoming = {
          channelType: "telegram",
          channelId: resolved.canal.id,
          tenantId: resolved.canal.tenant_id,
          contactoExterno: chatId,
          contactoNombre: m.from?.first_name,
          type: "command",
          command: cmd,
          text,
          externalMessageId: String(m.message_id),
        };
      } else {
        incoming = {
          channelType: "telegram",
          channelId: resolved.canal.id,
          tenantId: resolved.canal.tenant_id,
          contactoExterno: chatId,
          contactoNombre: m.from?.first_name,
          type: "text",
          text,
          externalMessageId: String(m.message_id),
        };
      }
    } else if (update.callback_query) {
      const cb = update.callback_query;
      incoming = {
        channelType: "telegram",
        channelId: resolved.canal.id,
        tenantId: resolved.canal.tenant_id,
        contactoExterno: chatId,
        contactoNombre: cb.from.first_name,
        type: "button_click",
        buttonData: cb.data,
        externalMessageId: cb.id,
      };
      void answerCallbackQuery(cb.id);
    }
  } catch (err) {
    console.error(`[tg:${updateId}] error construyendo IncomingMessage:`, err);
    return;
  }

  if (!incoming) return;

  // Procesar
  let outgoingMessages;
  try {
    outgoingMessages = await handleIncoming(incoming);
  } catch (err) {
    console.error(`[tg:${updateId}] handleIncoming lanzó:`, err);
    if (err instanceof Error) {
      console.error(`  message: ${err.message}`);
      console.error(`  stack: ${err.stack}`);
    }
    try {
      await telegramAdapter.send(resolved.canal.id, chatId, {
        kind: "text",
        text: "Tuve un problema técnico. Inténtalo otra vez en un momento.",
      });
    } catch {
      // best effort
    }
    return;
  }

  // Enviar
  for (let i = 0; i < outgoingMessages.length; i++) {
    try {
      await telegramAdapter.send(resolved.canal.id, chatId, outgoingMessages[i]);
    } catch (err) {
      console.error(`[tg:${updateId}] error enviando mensaje ${i + 1}:`, err);
    }
  }

  console.log(`[tg:${updateId}] procesado OK (${outgoingMessages.length} mensajes)`);
}


async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  const { ENV } = await import("../../config/env.js");
  const token = ENV.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  } catch {
    // best effort
  }
}
