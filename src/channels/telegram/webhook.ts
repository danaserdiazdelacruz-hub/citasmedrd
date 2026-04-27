// src/channels/telegram/webhook.ts
// Handler HTTP del webhook de Telegram con:
//   - Logs detallados por update
//   - Mutex por chat (anti-spam: 1 update a la vez por usuario)
//   - Cola con tope (descarta excedentes)
//   - Timeout duro (libera el lock si algo se cuelga)
//   - Deduplicación de clicks repetidos

import { handleIncoming } from "../../application/orchestrator.js";
import type { IncomingMessage } from "../core/types.js";
import { telegramAdapter } from "./adapter.js";

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


// ─── Mutex por chat ──────────────────────────────────────────────────

const MUTEX_TIMEOUT_MS = 12000;            // libera el lock si pasa más de 12s
const MAX_QUEUE_PER_CHAT = 3;               // descarta updates si la cola se llena
const DEDUP_WINDOW_MS = 2000;               // ignora botones duplicados dentro de 2s

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

/**
 * Encola una operación para un chat. Solo se ejecuta una a la vez.
 * Retorna inmediato (la operación corre en background).
 */
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

  // Lock libre, ejecutar ahora
  runWithLock(chatId, op);
}

function runWithLock(chatId: string, op: () => Promise<void>): void {
  const lock = getOrCreateLock(chatId);
  lock.busy = true;

  // Safety timeout: libera el lock si la operación se cuelga
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

  // ¿Hay algo en la cola? Procesarlo
  const next = lock.queue.shift();
  if (next) {
    runWithLock(chatId, next);
    return;
  }

  // Cola vacía, marcar libre
  lock.busy = false;

  // Limpieza: si nadie está esperando y nada en cola, eliminar entrada
  if (lock.queue.length === 0) {
    locks.delete(chatId);
  }
}

/**
 * ¿Es duplicado? Para clicks de botón muy rápidos con el mismo data.
 * Ej: usuario toca "Sede X" 3 veces seguidas → solo procesar la primera.
 */
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

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const updateId = update.update_id;
  console.log(`[tg:${updateId}] recibido`);

  // Identificar chat antes que nada (para mutex)
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

  // Deduplicación de botones
  if (update.callback_query?.data) {
    if (esDuplicadoBoton(chatId, update.callback_query.data)) {
      console.log(`[tg:${updateId}] click duplicado descartado: ${update.callback_query.data}`);
      // Igual responder al callback para que no quede el spinner
      void answerCallbackQuery(update.callback_query.id);
      return;
    }
  }

  // Encolar para procesamiento serializado por chat
  enqueueForChat(chatId, () => procesarUpdate(updateId, chatId!, update));
}


async function procesarUpdate(updateId: number, chatId: string, update: TelegramUpdate): Promise<void> {
  let canal: { canalId: string; tenantId: string } | null = null;
  try {
    canal = await resolveCanalTelegramActivo();
  } catch (err) {
    console.error(`[tg:${updateId}] error resolviendo canal:`, err);
    return;
  }

  if (!canal) {
    console.error(`[tg:${updateId}] no hay canal Telegram activo en DB`);
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
        const cmd = text.slice(1, cmdEntity.length).split("@")[0];
        incoming = {
          channelType: "telegram",
          channelId: canal.canalId,
          tenantId: canal.tenantId,
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
          channelId: canal.canalId,
          tenantId: canal.tenantId,
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
        channelId: canal.canalId,
        tenantId: canal.tenantId,
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

  // Procesar con orchestrator
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
      await telegramAdapter.send(canal.canalId, chatId, {
        kind: "text",
        text: "Tuve un problema técnico. Inténtalo otra vez en un momento.",
      });
    } catch {
      // no podemos hacer más
    }
    return;
  }

  // Enviar respuestas
  for (let i = 0; i < outgoingMessages.length; i++) {
    try {
      await telegramAdapter.send(canal.canalId, chatId, outgoingMessages[i]);
    } catch (err) {
      console.error(`[tg:${updateId}] error enviando mensaje ${i + 1}:`, err);
    }
  }

  console.log(`[tg:${updateId}] procesado OK (${outgoingMessages.length} mensajes)`);
}


async function resolveCanalTelegramActivo(): Promise<{ canalId: string; tenantId: string } | null> {
  const { getDb } = await import("../../persistence/db.js");
  const db = getDb();
  const { data, error } = await db
    .from("canales_conectados")
    .select("id, tenant_id, tenants!inner(estado)")
    .eq("tipo", "telegram")
    .eq("estado", "activo")
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[resolveCanal] error DB:`, error.message);
    return null;
  }
  if (!data) return null;

  type Row = { id: string; tenant_id: string; tenants: { estado: string } };
  const row = data as unknown as Row;
  if (row.tenants.estado !== "activo") return null;

  return { canalId: row.id, tenantId: row.tenant_id };
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
