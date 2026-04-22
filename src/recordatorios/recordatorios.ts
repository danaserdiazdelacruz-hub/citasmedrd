// ═══════════════════════════════════════════════════════════════
// RECORDATORIOS AUTOMÁTICOS DE CITAS
// Envía mensajes por Telegram 24h y 2h antes de cada cita
// ═══════════════════════════════════════════════════════════════
//
// Instalación:
// 1) Copiar este archivo a: src/recordatorios/recordatorios.ts
// 2) En package.json añadir: "node-cron": "^3.0.3"
// 3) Ejecutar: npm install
// 4) En src/index.ts añadir al final:
//      import { iniciarRecordatorios } from "./recordatorios/recordatorios";
//      iniciarRecordatorios();
// 5) Asegurarse de que la tabla `citas` tiene columna `recordatorio_24h_enviado` y `recordatorio_2h_enviado`
//    Si no existen, ejecutar en Supabase SQL Editor:
//      ALTER TABLE citas
//        ADD COLUMN IF NOT EXISTS recordatorio_24h_enviado BOOLEAN DEFAULT FALSE,
//        ADD COLUMN IF NOT EXISTS recordatorio_2h_enviado BOOLEAN DEFAULT FALSE;
// 6) Asegurarse de que bot_sesiones guarda el chatId de Telegram (ya lo hace)
//
// Cómo funciona:
// - Cada 15 minutos corre un cron job
// - Busca citas que necesiten recordatorio 24h (entre 23h45min y 24h15min antes)
// - Busca citas que necesiten recordatorio 2h (entre 1h45min y 2h15min antes)
// - Envía mensaje por Telegram al paciente
// - Marca el recordatorio como enviado para no repetirlo

import cron from "node-cron";
import { supabase } from "../lib/supabase";
import { telegram } from "../bot/telegram";
import { ENV } from "../lib/env";

// Formatea fecha/hora en español dominicano
function formatearFechaHumana(fechaISO: string): string {
  const dt = new Date(fechaISO);
  const dias = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${dias[dt.getDay()]} ${dt.getDate()} de ${meses[dt.getMonth()]} a las ${hh}:${mm}`;
}

// Query base: trae citas activas con su paciente, sede, doctor y chatId de Telegram
async function traerCitasParaRecordatorio(
  ventanaInicio: Date,
  ventanaFin: Date,
  columnaYaEnviado: "recordatorio_24h_enviado" | "recordatorio_2h_enviado"
) {
  const { data, error } = await supabase
    .from("citas")
    .select(`
      id, codigo, inicia_en, motivo, estado, canal, identificador_canal,
      ${columnaYaEnviado},
      pacientes ( nombre, telefono ),
      doctor_clinica (
        doctores ( nombre ),
        clinicas ( nombre, ciudad )
      )
    `)
    .in("estado", ["pendiente", "confirmada"])
    .eq(columnaYaEnviado, false)
    .gte("inicia_en", ventanaInicio.toISOString())
    .lte("inicia_en", ventanaFin.toISOString());

  if (error) {
    console.error("[recordatorios] Error consultando citas:", error);
    return [];
  }
  return data || [];
}

// Busca el chatId de Telegram del paciente basado en el teléfono o en bot_sesiones
async function resolverChatIdTelegram(cita: any): Promise<string | null> {
  // Si la cita vino por Telegram, el identificador_canal ES el chatId
  if (cita.canal === "telegram" && cita.identificador_canal) {
    return cita.identificador_canal;
  }

  // Si no: buscar en bot_sesiones por el teléfono del paciente
  const telefono = cita.pacientes?.telefono;
  if (!telefono) return null;

  const { data } = await supabase
    .from("bot_sesiones")
    .select("chat_id, canal")
    .eq("canal", "telegram")
    .order("actualizado_en", { ascending: false })
    .limit(50);

  // TODO: cruzar por teléfono requiere que bot_sesiones lo guarde.
  // Por ahora solo funciona si la cita fue creada por Telegram.
  return null;
}

// Envía el recordatorio por Telegram
async function enviarRecordatorio(cita: any, tipo: "24h" | "2h"): Promise<boolean> {
  const chatId = await resolverChatIdTelegram(cita);
  if (!chatId) {
    console.log(`[recordatorios] Sin chatId para cita ${cita.codigo}, saltando`);
    return false;
  }

  const doctor = cita.doctor_clinica?.doctores?.nombre || "su doctor";
  const sede = cita.doctor_clinica?.clinicas?.nombre || "";
  const ciudad = cita.doctor_clinica?.clinicas?.ciudad || "";
  const paciente = cita.pacientes?.nombre || "";
  const cuando = formatearFechaHumana(cita.inicia_en);

  let mensaje = "";
  if (tipo === "24h") {
    mensaje =
      `🔔 *Recordatorio de su cita — Mañana*\n\n` +
      `Hola ${paciente} 😊\n\n` +
      `Le recordamos su cita con *${doctor}* programada para:\n` +
      `📅 ${cuando}\n` +
      `📍 ${sede}${ciudad ? ", " + ciudad : ""}\n` +
      `🔖 Código: ${cita.codigo}\n\n` +
      `Si necesita cancelar o reagendar, respóndame por aquí y le ayudo con gusto.\n\n` +
      `_— María Salud, CitasMed RD_`;
  } else {
    mensaje =
      `⏰ *Su cita es en 2 horas*\n\n` +
      `Hola ${paciente}, le recordamos:\n\n` +
      `*Cita con ${doctor}*\n` +
      `📅 ${cuando}\n` +
      `📍 ${sede}${ciudad ? ", " + ciudad : ""}\n` +
      `🔖 ${cita.codigo}\n\n` +
      `Por favor llegue unos minutos antes.\n` +
      `¡Lo esperamos! 🙏`;
  }

  try {
    await telegram.sendMessage(chatId, mensaje, { parse_mode: "Markdown" });
    console.log(`[recordatorios] Enviado ${tipo} a ${paciente} para cita ${cita.codigo}`);
    return true;
  } catch (e) {
    console.error(`[recordatorios] Error enviando ${tipo} a ${paciente}:`, e);
    return false;
  }
}

// Marca el recordatorio como enviado
async function marcarEnviado(citaId: string, tipo: "24h" | "2h") {
  const columna = tipo === "24h" ? "recordatorio_24h_enviado" : "recordatorio_2h_enviado";
  await supabase.from("citas").update({ [columna]: true }).eq("id", citaId);
}

// Ejecuta ciclo completo de recordatorios
export async function ejecutarCicloRecordatorios() {
  const ahora = new Date();

  // ═══ Ventana 24h: citas que ocurrirán entre 23h45min y 24h15min a partir de ahora
  const v24Inicio = new Date(ahora.getTime() + (23 * 60 + 45) * 60000);
  const v24Fin = new Date(ahora.getTime() + (24 * 60 + 15) * 60000);
  const citas24h = await traerCitasParaRecordatorio(v24Inicio, v24Fin, "recordatorio_24h_enviado");
  console.log(`[recordatorios] Ciclo 24h: ${citas24h.length} citas candidatas`);

  for (const cita of citas24h) {
    const enviado = await enviarRecordatorio(cita, "24h");
    if (enviado) await marcarEnviado(cita.id, "24h");
    await sleep(300); // rate limit de Telegram
  }

  // ═══ Ventana 2h: citas entre 1h45min y 2h15min
  const v2Inicio = new Date(ahora.getTime() + (1 * 60 + 45) * 60000);
  const v2Fin = new Date(ahora.getTime() + (2 * 60 + 15) * 60000);
  const citas2h = await traerCitasParaRecordatorio(v2Inicio, v2Fin, "recordatorio_2h_enviado");
  console.log(`[recordatorios] Ciclo 2h: ${citas2h.length} citas candidatas`);

  for (const cita of citas2h) {
    const enviado = await enviarRecordatorio(cita, "2h");
    if (enviado) await marcarEnviado(cita.id, "2h");
    await sleep(300);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Inicia el cron job (cada 15 minutos)
export function iniciarRecordatorios() {
  // Solo iniciar si está configurado
  if (!ENV.TELEGRAM_BOT_TOKEN) {
    console.log("[recordatorios] Telegram no configurado, saltando");
    return;
  }

  console.log("[recordatorios] Iniciando cron cada 15 min");

  // Ejecuta cada 15 minutos: 0, 15, 30, 45
  cron.schedule("0,15,30,45 * * * *", () => {
    console.log(`[recordatorios] Tick ${new Date().toISOString()}`);
    ejecutarCicloRecordatorios().catch((e) => {
      console.error("[recordatorios] Error en ciclo:", e);
    });
  }, {
    timezone: ENV.TIMEZONE || "America/Santo_Domingo",
  });

  // Ejecutar uno al inicio (tras 30s de arranque) para probar
  setTimeout(() => {
    ejecutarCicloRecordatorios().catch((e) => {
      console.error("[recordatorios] Error en ciclo inicial:", e);
    });
  }, 30000);
}
