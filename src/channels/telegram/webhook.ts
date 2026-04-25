// src/channels/telegram/webhook.ts
// Handler HTTP del webhook de Telegram.
// Convierte el payload de Telegram a IncomingMessage normalizado,
// llama al orchestrator, y envía la respuesta vía adapter.

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

/**
 * Procesa un update de Telegram. Resuelve tenant a partir del bot username.
 * Esta función la llama el index.ts cuando entra POST /webhook/telegram.
 */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  // Resolver tenant: lo hacemos por bot username. En este flujo sabemos que
  // hay un solo bot configurado (citasmed_rd_bot). Para multi-tenant en
  // producción, usaríamos un webhook por bot. Por ahora, buscamos el canal
  // activo por tipo.
  // Estrategia simple: hay 1 canal Telegram activo en la DB → ese es el tenant.

  // En el futuro, cuando haya múltiples bots, cada uno tendrá su propia URL
  // con el token en el path para distinguir. Por ahora 1:1.

  const canal = await resolveCanalTelegramActivo();
  if (!canal) {
    console.error("[telegram] No hay canal Telegram activo en DB");
    return;
  }

  // Construir IncomingMessage
  let incoming: IncomingMessage | null = null;

  if (update.message) {
    const m = update.message;
    const text = m.text ?? "";

    // ¿Es un comando? Telegram marca commands con entity type=bot_command
    const cmdEntity = m.entities?.find(e => e.type === "bot_command" && e.offset === 0);
    if (cmdEntity) {
      const cmd = text.slice(1, cmdEntity.length).split("@")[0]; // quitar @username si lo trae
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

    // Telegram requiere responder al callback_query rápido (menos de 3s)
    // sino el botón se queda con loading spinner.
    void answerCallbackQuery(cb.id);
  }

  if (!incoming) {
    console.warn("[telegram] Update sin message ni callback_query, ignorado");
    return;
  }

  // Procesar con el orchestrator
  let outgoingMessages;
  try {
    outgoingMessages = await handleIncoming(incoming);
  } catch (err) {
    console.error("[telegram] Error en orchestrator:", err);
    await telegramAdapter.send(canal.canalId, incoming.contactoExterno, {
      kind: "text",
      text: "Tuve un problema técnico. Por favor intenta de nuevo en un momento. Si persiste, comunícate con el consultorio.",
    });
    return;
  }

  // Enviar todas las respuestas
  for (const msg of outgoingMessages) {
    await telegramAdapter.send(canal.canalId, incoming.contactoExterno, msg);
  }
}


/**
 * Resuelve el único canal Telegram activo (modelo simple multi-tenant via webhook único).
 * En producción multi-bot esto cambiaría a "resolveByBotUsername" o similar.
 */
async function resolveCanalTelegramActivo(): Promise<{ canalId: string; tenantId: string } | null> {
  // Hack temporal: buscamos cualquier canal Telegram activo. Suficiente para
  // tenants pilot. Para multi-bot real, configurar webhook con secret token
  // distinto por bot y rutearlos en index.ts.
  const { getDb } = await import("../../persistence/db.js");
  const db = getDb();
  const { data, error } = await db
    .from("canales_conectados")
    .select("id, tenant_id, tenants!inner(estado)")
    .eq("tipo", "telegram")
    .eq("estado", "activo")
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

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
    // best effort, no es crítico
  }
}
