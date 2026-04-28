// src/channels/telegram/adapter.ts
// Adapter Telegram. Implementa ChannelAdapter.
// Convierte mensajes salientes (texto/botones/lista) a la API de Telegram.

import { ENV } from "../../config/env.js";
import type { ChannelAdapter, ChannelCapabilities, OutgoingMessage } from "../core/types.js";

const TG_API = "https://api.telegram.org/bot";

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram" as const;
  readonly capabilities: ChannelCapabilities = {
    maxButtons: 8,        // Telegram permite más, pero 8 es buena UX
    supportsLists: true,
    supportsImages: true,
  };

  async send(_channelId: string, contactoExterno: string, msg: OutgoingMessage): Promise<void> {
    const token = ENV.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error("[telegram] TELEGRAM_BOT_TOKEN no configurado");
      return;
    }
    const chatId = contactoExterno;

    if (msg.kind === "text") {
      await this.callApi(token, "sendMessage", {
        chat_id: chatId,
        text: msg.text,
        parse_mode: "Markdown",
      });
      return;
    }

    if (msg.kind === "buttons") {
      // Telegram inline keyboard: array de filas, cada fila es array de botones
      // Para 1-3 botones: 1 por fila. Para más: 2 por fila.
      const inline = msg.buttons.length <= 3
        ? msg.buttons.map(b => [{ text: b.label, callback_data: b.data }])
        : chunk(msg.buttons.map(b => ({ text: b.label, callback_data: b.data })), 2);

      await this.callApi(token, "sendMessage", {
        chat_id: chatId,
        text: msg.text,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: inline },
      });
      return;
    }

    if (msg.kind === "list") {
      // Telegram no tiene listas nativas como WhatsApp. Las renderizamos como
      // mensaje + botones inline, uno por opción (max 10 opciones).
      const inline = msg.options.slice(0, 10).map(o => [
        { text: o.label, callback_data: o.data },
      ]);

      await this.callApi(token, "sendMessage", {
        chat_id: chatId,
        text: msg.text,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: inline },
      });
      return;
    }
  }

  private async callApi(token: string, method: string, body: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(`${TG_API}${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error(`[telegram] ${method} fallo: ${res.status} ${errText}`);
      }
    } catch (err) {
      console.error(`[telegram] ${method} excepción:`, err);
    }
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

export const telegramAdapter = new TelegramAdapter();
