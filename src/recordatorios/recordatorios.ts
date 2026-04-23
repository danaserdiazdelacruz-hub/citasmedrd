// ═══════════════════════════════════════════════════════════════
// RECORDATORIOS AUTOMÁTICOS DE CITAS
// Envía mensajes por Telegram 24h y 2h antes de cada cita.
// ═══════════════════════════════════════════════════════════════

import cron from "node-cron";
import { supabase } from "../lib/supabase.js";
import { enviar as enviarTelegram } from "../bot/telegram.js";
import { ENV } from "../lib/env.js";

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
  const r = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    select: `id,codigo,inicia_en,motivo,estado,canal,identificador_canal,${columnaYaEnviado},pacientes(nombre,apellido,telefono),doctor_clinica(doctores(nombre),clinicas(nombre,ciudad))`,
    estado: "in.(pendiente,confirmada)",
    [columnaYaEnviado]: "eq.false",
    inicia_en: `gte.${ventanaInicio.toISOString()}`,
    "and": `(inicia_en.lte.${ventanaFin.toISOString()})`,
  });

  if (!r.data || !Array.isArray(r.data)) {
    console.warn("[recordatorios] No se pudieron traer citas");
    return [];
  }
  // Filtrar en código la ventana superior (PostgREST requiere ambos lados en params separados)
  return r.data.filter(c => {
    const t = new Date(c.inicia_en).getTime();
    return t >= ventanaInicio.getTime() && t <= ventanaFin.getTime();
  });
}

// Busca el chatId de Telegram del paciente
async function resolverChatIdTelegram(cita: any): Promise<string | null> {
  // Si la cita vino por Telegram, el identificador_canal ES el chatId
  if (cita.canal === "telegram" && cita.identificador_canal) {
    return cita.identificador_canal;
  }

  // Si no vino por Telegram, no tenemos chatId (aún)
  // Cuando integremos WhatsApp, aquí agregaríamos otra ruta
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
  const pacienteNombre = cita.pacientes?.nombre || "";
  const cuando = formatearFechaHumana(cita.inicia_en);

  let mensaje = "";
  if (tipo === "24h") {
    mensaje =
      `🔔 *Recordatorio de su cita — Mañana*\n\n` +
      `Hola ${pacienteNombre} 😊\n\n` +
      `Le recordamos su cita con *${doctor}* programada para:\n` +
      `📅 ${cuando}\n` +
      `📍 ${sede}${ciudad ? ", " + ciudad : ""}\n` +
      `🔖 Código: ${cita.codigo}\n\n` +
      `Si necesita cancelar o reagendar, respóndame por aquí y le ayudo con gusto.\n\n` +
      `_— María Salud, CitasMed RD_`;
  } else {
    mensaje =
      `⏰ *Su cita es en 2 horas*\n\n` +
      `Hola ${pacienteNombre}, le recordamos:\n\n` +
      `*Cita con ${doctor}*\n` +
      `📅 ${cuando}\n` +
      `📍 ${sede}${ciudad ? ", " + ciudad : ""}\n` +
      `🔖 ${cita.codigo}\n\n` +
      `Por favor llegue unos minutos antes.\n` +
      `¡Lo esperamos! 🙏`;
  }

  try {
    await enviarTelegram(chatId, mensaje);
    console.log(`[recordatorios] Enviado ${tipo} a ${pacienteNombre} para cita ${cita.codigo}`);
    return true;
  } catch (e) {
    console.error(`[recordatorios] Error enviando ${tipo} a ${pacienteNombre}:`, e);
    return false;
  }
}

// Marca el recordatorio como enviado
async function marcarEnviado(citaId: string, tipo: "24h" | "2h") {
  const columna = tipo === "24h" ? "recordatorio_24h_enviado" : "recordatorio_2h_enviado";
  await supabase(
    "PATCH",
    "/rest/v1/citas",
    { [columna]: true },
    { id: `eq.${citaId}` }
  );
}

// Ejecuta ciclo completo de recordatorios
export async function ejecutarCicloRecordatorios() {
  const ahora = new Date();

  // Ventana 24h
  const v24Inicio = new Date(ahora.getTime() + (23 * 60 + 45) * 60000);
  const v24Fin = new Date(ahora.getTime() + (24 * 60 + 15) * 60000);
  const citas24h = await traerCitasParaRecordatorio(v24Inicio, v24Fin, "recordatorio_24h_enviado");
  console.log(`[recordatorios] Ciclo 24h: ${citas24h.length} citas candidatas`);

  for (const cita of citas24h) {
    const enviado = await enviarRecordatorio(cita, "24h");
    if (enviado) await marcarEnviado(cita.id, "24h");
    await sleep(300);
  }

  // Ventana 2h
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

export function iniciarRecordatorios() {
  if (!ENV.TELEGRAM_BOT_TOKEN) {
    console.log("[recordatorios] Telegram no configurado, saltando");
    return;
  }

  console.log("[recordatorios] Iniciando cron cada 15 min");

  cron.schedule("0,15,30,45 * * * *", () => {
    console.log(`[recordatorios] Tick ${new Date().toISOString()}`);
    ejecutarCicloRecordatorios().catch((e) => {
      console.error("[recordatorios] Error en ciclo:", e);
    });
  }, {
    timezone: ENV.TIMEZONE || "America/Santo_Domingo",
  });

  // Primer tick a los 30s tras arranque
  setTimeout(() => {
    ejecutarCicloRecordatorios().catch((e) => {
      console.error("[recordatorios] Error en ciclo inicial:", e);
    });
  }, 30000);
}
