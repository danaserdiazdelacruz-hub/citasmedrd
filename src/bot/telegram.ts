// ================================================================
// telegram.ts — Envía mensajes a Telegram.
// ================================================================
import { ENV } from "../lib/env.js";

const TG = () => `https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}`;

export async function enviar(chatId: string | number, texto: string, extra?: object): Promise<void> {
  try {
    await fetch(`${TG()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    chatId,
        text:       texto,
        parse_mode: "Markdown",
        ...extra,
      }),
    });
  } catch (err) {
    console.error("[Telegram] Error enviando mensaje:", err);
  }
}

export async function enviarConBotones(
  chatId: string | number,
  texto: string,
  botones: string[][],  // array de filas, cada fila tiene textos de botones
): Promise<void> {
  const keyboard = botones.map(fila =>
    fila.map(texto => ({ text: texto }))
  );
  await enviar(chatId, texto, {
    reply_markup: {
      keyboard,
      one_time_keyboard: true,
      resize_keyboard:   true,
    },
  });
}

export async function quitarTeclado(chatId: string | number, texto: string): Promise<void> {
  await enviar(chatId, texto, {
    reply_markup: { remove_keyboard: true },
  });
}
