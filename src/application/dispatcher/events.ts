// src/application/dispatcher/events.ts
// Normaliza IncomingMessage crudo → EventoInterno tipado.
// El dispatcher trabaja únicamente con EventoInterno.
// Aísla el resto del sistema del shape de IncomingMessage.

import type { IncomingMessage } from "../../channels/core/types.js";
import type { EventoInterno } from "../types.js";
import { textoComoComando } from "../../domain/comandos.js";

export function normalizeEvent(msg: IncomingMessage): EventoInterno {
  // Comando explícito de Telegram
  if (msg.type === "command") {
    return {
      tipo: "command",
      command: msg.command,
      commandArg: msg.commandArg,
      tenantId: msg.tenantId,
      chatId: msg.contactoExterno,
    };
  }

  // Texto que parece comando escrito a mano (/Star, /Menu, etc.)
  if (msg.type === "text" && msg.text) {
    const cmdLike = textoComoComando(msg.text);
    if (cmdLike) {
      return {
        tipo: "command",
        command: cmdLike,
        tenantId: msg.tenantId,
        chatId: msg.contactoExterno,
      };
    }
  }

  // Click de botón
  if (msg.type === "button_click" && msg.buttonData) {
    const colon = msg.buttonData.indexOf(":");
    const tipo  = colon >= 0 ? msg.buttonData.slice(0, colon) : msg.buttonData;
    const valor = colon >= 0 ? msg.buttonData.slice(colon + 1) : "";
    return {
      tipo: "button",
      buttonTipo: tipo,
      buttonValor: valor,
      tenantId: msg.tenantId,
      chatId: msg.contactoExterno,
    };
  }

  // Texto libre
  return {
    tipo: "text",
    text: msg.text ?? "",
    tenantId: msg.tenantId,
    chatId: msg.contactoExterno,
  };
}
