// src/routes/webhook.ts — Endurecido para producción
// - Valida el X-Telegram-Bot-Api-Secret-Token (previene webhook falsos)
// - Rate limit por chat_id (previene spam de un usuario)
// - Límite de longitud de mensaje (previene prompts gigantes hacia el LLM)
// - Ignora mensajes que no son texto (fotos, stickers, etc.)

import { Router } from "express";
import { procesarMensaje } from "../bot/flujo.js";
import { ENV } from "../lib/env.js";

export const webhookRouter = Router();

const MAX_LEN_MENSAJE = 500;           // caracteres por mensaje de usuario
const MAX_MSGS_POR_MINUTO_POR_CHAT = 12;

// Bucket simple en memoria por chat_id. Para multi-instancia, usar Redis.
const bucketsPorChat = new Map<string, { count: number; resetAt: number }>();

function chequearRateLimitChat(chatId: string): boolean {
  const now = Date.now();
  const b = bucketsPorChat.get(chatId);
  if (!b || b.resetAt <= now) {
    bucketsPorChat.set(chatId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  b.count++;
  return b.count <= MAX_MSGS_POR_MINUTO_POR_CHAT;
}

// Limpieza periódica
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of bucketsPorChat.entries()) {
    if (v.resetAt <= now) bucketsPorChat.delete(k);
  }
}, 120_000);

webhookRouter.post("/telegram", async (req, res) => {
  // 1) Validación del secret_token enviado por Telegram en el header.
  //    Se configura cuando llamas setWebhook con secret_token=...
  //    Si TELEGRAM_WEBHOOK_SECRET está definido, lo exigimos.
  const expected = (ENV as any).TELEGRAM_WEBHOOK_SECRET as string | undefined;
  if (expected) {
    const recibido = req.headers["x-telegram-bot-api-secret-token"];
    if (recibido !== expected) {
      console.warn(`[webhook] secret token inválido desde IP ${req.ip}`);
      return res.sendStatus(401);
    }
  }

  // 2) Responder 200 de inmediato para no hacer timeout a Telegram
  res.sendStatus(200);

  try {
    const update = req.body;
    if (!update?.message) return;

    const chatId = String(update.message.chat?.id ?? "");
    const texto = update.message.text;

    // 3) Validaciones básicas
    if (!chatId) return;
    if (typeof texto !== "string" || !texto.trim()) return; // ignora stickers, fotos, etc.
    if (texto.length > MAX_LEN_MENSAJE) {
      console.warn(`[webhook] mensaje gigante (${texto.length} chars) de chat ${chatId}, ignorado`);
      return;
    }

    // 4) Rate limit por chat
    if (!chequearRateLimitChat(chatId)) {
      console.warn(`[webhook] rate limit excedido para chat ${chatId}`);
      return;
    }

    // 5) Procesar sin bloquear
    procesarMensaje(chatId, texto.trim()).catch(err => {
      console.error(`[webhook] error procesando chat ${chatId}:`, err.message);
    });
  } catch (err: any) {
    console.error("[webhook] error inesperado:", err.message);
  }
});
