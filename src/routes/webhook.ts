// POST /webhook/telegram
// Telegram llama este endpoint cada vez que alguien escribe al bot.
import { Router } from "express";
import { procesarMensaje } from "../bot/flujo.js";

export const webhookRouter = Router();

webhookRouter.post("/telegram", async (req, res) => {
  // Responder 200 inmediatamente — Telegram requiere respuesta rápida
  res.sendStatus(200);

  const update = req.body;
  if (!update?.message) return;

  const chatId = String(update.message.chat.id);
  const texto  = update.message.text?.trim() ?? "";

  if (!texto) return;

  // Procesar en background sin bloquear la respuesta
  procesarMensaje(chatId, texto).catch(err => {
    console.error("[Webhook] Error procesando mensaje:", err);
  });
});
