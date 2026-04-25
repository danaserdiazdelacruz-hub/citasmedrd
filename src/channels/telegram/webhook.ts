// src/channels/telegram/webhook.ts
// Handler HTTP del webhook de Telegram con LOGS EXHAUSTIVOS para diagnóstico.

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

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const updateId = update.update_id;
  console.log(`[tg:${updateId}] PASO 1: handleTelegramUpdate iniciado`);

  let canal: { canalId: string; tenantId: string } | null = null;
  try {
    canal = await resolveCanalTelegramActivo();
    console.log(`[tg:${updateId}] PASO 2: canal resuelto:`, canal);
  } catch (err) {
    console.error(`[tg:${updateId}] PASO 2 FALLO al resolver canal:`, err);
    return;
  }

  if (!canal) {
    console.error(`[tg:${updateId}] PASO 2 FALLO: no hay canal Telegram activo en DB`);
    return;
  }

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
          contactoExterno: String(m.chat.id),
          contactoNombre: m.from?.first_name,
          type: "command",
          command: cmd,
          text,
          externalMessageId: String(m.message_id),
          raw: update,
        };
        console.log(`[tg:${updateId}] PASO 3: comando detectado: /${cmd}`);
      } else {
        incoming = {
          channelType: "telegram",
          channelId: canal.canalId,
          tenantId: canal.tenantId,
          contactoExterno: String(m.chat.id),
          contactoNombre: m.from?.first_name,
          type: "text",
          text,
          externalMessageId: String(m.message_id),
          raw: update,
        };
        console.log(`[tg:${updateId}] PASO 3: texto: "${text.slice(0, 60)}"`);
      }
    } else if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat.id ?? cb.from.id;
      incoming = {
        channelType: "telegram",
        channelId: canal.canalId,
        tenantId: canal.tenantId,
        contactoExterno: String(chatId),
        contactoNombre: cb.from.first_name,
        type: "button_click",
        buttonData: cb.data,
        externalMessageId: cb.id,
        raw: update,
      };
      console.log(`[tg:${updateId}] PASO 3: button_click data="${cb.data}"`);
      void answerCallbackQuery(cb.id);
    }
  } catch (err) {
    console.error(`[tg:${updateId}] PASO 3 FALLO al construir IncomingMessage:`, err);
    return;
  }

  if (!incoming) {
    console.warn(`[tg:${updateId}] update sin message ni callback_query, ignorado`);
    return;
  }

  console.log(`[tg:${updateId}] PASO 4: llamando handleIncoming…`);

  let outgoingMessages;
  try {
    outgoingMessages = await handleIncoming(incoming);
    console.log(`[tg:${updateId}] PASO 5: handleIncoming devolvió ${outgoingMessages.length} mensajes`);
  } catch (err) {
    console.error(`[tg:${updateId}] PASO 4-5 FALLO en handleIncoming:`);
    console.error(err);
    if (err instanceof Error) {
      console.error(`  message: ${err.message}`);
      console.error(`  stack: ${err.stack}`);
    }
    try {
      await telegramAdapter.send(canal.canalId, incoming.contactoExterno, {
        kind: "text",
        text: "Tuve un problema técnico. Por favor intenta de nuevo en un momento.",
      });
    } catch (sendErr) {
      console.error(`[tg:${updateId}] FALLO también al enviar mensaje de error:`, sendErr);
    }
    return;
  }

  console.log(`[tg:${updateId}] PASO 6: enviando ${outgoingMessages.length} mensajes a Telegram…`);
  for (let i = 0; i < outgoingMessages.length; i++) {
    try {
      await telegramAdapter.send(canal.canalId, incoming.contactoExterno, outgoingMessages[i]);
      console.log(`[tg:${updateId}] PASO 6.${i + 1}: mensaje ${i + 1}/${outgoingMessages.length} enviado OK`);
    } catch (err) {
      console.error(`[tg:${updateId}] PASO 6.${i + 1} FALLO al enviar mensaje:`, err);
    }
  }

  console.log(`[tg:${updateId}] PASO 7: COMPLETO ✓`);
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
    console.error(`[resolveCanalTelegramActivo] error DB:`, error.message);
    return null;
  }
  if (!data) {
    console.error(`[resolveCanalTelegramActivo] no se encontró canal Telegram activo`);
    return null;
  }

  type Row = { id: string; tenant_id: string; tenants: { estado: string } };
  const row = data as unknown as Row;
  if (row.tenants.estado !== "activo") {
    console.error(`[resolveCanalTelegramActivo] tenant no activo: ${row.tenants.estado}`);
    return null;
  }

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
