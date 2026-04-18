// src/bot/flujo.ts — Entry point simplificado

import { getSesion, setSesion, deleteSesion } from "./sesion.js";
import { enviar } from "./telegram.js";
import { ejecutarAgente } from "./agente.js";

const BIENVENIDA = "Hola 😊, bienvenido a CitasMed RD. Soy María Salud.\nEstoy aquí para ayudarle. ¿En qué puedo asistirle hoy?";

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

  // Ejecutar agente
  const { respuesta, historialActualizado } = await ejecutarAgente(historial as any, texto, chatId);

  // Enviar respuesta
  await enviar(chatId, respuesta);

  // Guardar sesión
  const histLimpio = historialActualizado
    .filter((m: any) => typeof m.content === "string" || Array.isArray(m.content))
    .slice(-20);

  await setSesion(chatId, { historial: histLimpio });
}
