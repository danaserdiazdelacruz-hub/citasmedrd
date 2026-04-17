// src/bot/flujo.ts — Entry point simplificado
// Solo maneja sesión y delega TODO al agente

import { getSesion, setSesion, deleteSesion } from "./sesion.js";
import { enviar } from "./telegram.js";
import { ejecutarAgente } from "./agente.js";

const BIENVENIDA = "Bienvenidos a CitasMed RD.\nIndique el nombre del doctor o extensión para comenzar.";

export async function procesarMensaje(chatId: string, texto: string): Promise<void> {
  const tl = texto.toLowerCase().trim();

  // /start SIEMPRE reinicia
  if (texto === "/start") {
    await deleteSesion(chatId);
    await enviar(chatId, BIENVENIDA);
    await setSesion(chatId, { historial: [{ role: "assistant", content: BIENVENIDA }] });
    return;
  }

  // Cargar sesión
  const ses = await getSesion(chatId);
  const historial = ses.historial ?? [];

  // Si no hay sesión, tratar como inicio
  if (historial.length === 0) {
    await enviar(chatId, BIENVENIDA);
    await setSesion(chatId, { historial: [{ role: "assistant", content: BIENVENIDA }] });
    return;
  }

  // Ejecutar agente
  const { respuesta, historialActualizado } = await ejecutarAgente(historial as any, texto);

  // Enviar respuesta
  await enviar(chatId, respuesta);

  // Guardar sesión (solo últimos 20 mensajes limpios para no desbordar)
  const histLimpio = historialActualizado
    .filter((m: any) => {
      // Mantener mensajes de texto (user/assistant con string content)
      if (typeof m.content === "string") return true;
      // Mantener tool_result y tool_use para contexto
      if (Array.isArray(m.content)) return true;
      return false;
    })
    .slice(-20);

  await setSesion(chatId, { historial: histLimpio });
}
