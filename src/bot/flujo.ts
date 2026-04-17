// src/bot/flujo.ts — Entry point simplificado
// Solo maneja sesión y delega TODO al agente

import { getSesion, setSesion, deleteSesion } from "./sesion.js";
import { enviar } from "./telegram.js";
import { ejecutarAgente } from "./agente.js";

const BIENVENIDA = "Hola 😊, bienvenido a CitasMed RD.\nTu cita médica, sin complicaciones.\n\n¿Con qué doctor le gustaría agendar?";

export async function procesarMensaje(chatId: string, texto: string): Promise<void> {
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

  // Ejecutar agente (pasa chatId para seguridad)
  const { respuesta, historialActualizado } = await ejecutarAgente(historial as any, texto, chatId);

  // Enviar respuesta
  await enviar(chatId, respuesta);

  // Guardar sesión (últimos 20 mensajes)
  const histLimpio = historialActualizado
    .filter((m: any) => typeof m.content === "string" || Array.isArray(m.content))
    .slice(-20);

  await setSesion(chatId, { historial: histLimpio });
}
