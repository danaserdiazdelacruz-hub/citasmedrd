// ================================================================
// flujo.ts — Lógica principal del bot.
// Cada función maneja un paso del flujo de agendamiento.
// ================================================================
import { BotSesion } from "./types.js";
import { DOCTORES } from "./config.js";
import { getSesion, setSesion, deleteSesion } from "./sesion.js";
import { enviar, enviarConBotones, quitarTeclado } from "./telegram.js";
import { rpc, supabase } from "../lib/supabase.js";
import { normalizeTelefono, toLocalTime } from "../lib/dates.js";
import {
  interpretarTipoConsulta,
  extraerNombre,
  extraerTelefono,
  interpretarConfirmacion,
  detectarIntencionCancelar,
} from "./claude-ai.js";

const DIAS  = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const MESES = ["","ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

function formatFecha(fecha: string): string {
  const d = new Date(fecha + "T00:00:00");
  return `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth() + 1]}`;
}

// ── Punto de entrada ─────────────────────────────────────────
export async function procesarMensaje(chatId: string, texto: string): Promise<void> {
  const textoLower = texto.toLowerCase().trim();

  // Comandos globales — funcionan en cualquier paso
  if (texto === "/start" || textoLower === "hola" || textoLower === "inicio") {
    await deleteSesion(chatId);
    await mostrarInicio(chatId);
    return;
  }

  if (texto === "/cancelar" || textoLower === "cancelar cita") {
    const sesion = await getSesion(chatId);
    await setSesion(chatId, { ...sesion, paso: "cancelar_cita" });
    await enviar(chatId, "🔍 Escríbeme el *código* de tu cita (ej: CITA-A3B9K2) para cancelarla:");
    return;
  }

  // Detectar intención de cancelar con IA
  const quiereCancelar = await detectarIntencionCancelar(texto);
  if (quiereCancelar) {
    const sesion = await getSesion(chatId);
    await setSesion(chatId, { ...sesion, paso: "cancelar_cita" });
    await enviar(chatId, "🔍 Escríbeme el *código* de tu cita (ej: CITA-A3B9K2) para cancelarla:");
    return;
  }

  const sesion = await getSesion(chatId);

  switch (sesion.paso) {
    case "inicio":        return manejarInicio(chatId, texto, sesion);
    case "elegir_doctor": return manejarDoctor(chatId, texto, sesion);
    case "elegir_sede":   return manejarSede(chatId, texto, sesion);
    case "tipo_consulta": return manejarTipoConsulta(chatId, texto, sesion);
    case "nombre":        return manejarNombre(chatId, texto, sesion);
    case "telefono":      return manejarTelefono(chatId, texto, sesion);
    case "motivo":        return manejarMotivo(chatId, texto, sesion);
    case "elegir_dia":    return manejarElegirDia(chatId, texto, sesion);
    case "elegir_hora":   return manejarElegirHora(chatId, texto, sesion);
    case "confirmar":     return manejarConfirmar(chatId, texto, sesion);
    case "cancelar_cita": return manejarCancelarCita(chatId, texto);
    default:
      await deleteSesion(chatId);
      await mostrarInicio(chatId);
  }
}

// ── INICIO ───────────────────────────────────────────────────
async function mostrarInicio(chatId: string): Promise<void> {
  const botones = DOCTORES.map((d, i) => [`${i + 1}. ${d.nombre} — ${d.especialidad}`]);
  botones.push(["❌ Cancelar una cita"]);

  await enviarConBotones(
    chatId,
    "👋 ¡Hola! Soy el asistente de citas médicas.\n\n¿Con qué doctor deseas consultar?",
    botones,
  );
  await setSesion(chatId, { paso: "elegir_doctor" });
}

async function manejarInicio(chatId: string, texto: string, _sesion: BotSesion): Promise<void> {
  await mostrarInicio(chatId);
}

// ── ELEGIR DOCTOR ────────────────────────────────────────────
async function manejarDoctor(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  if (texto.toLowerCase().includes("cancelar una cita")) {
    await setSesion(chatId, { ...sesion, paso: "cancelar_cita" });
    await enviar(chatId, "🔍 Escríbeme el *código* de tu cita para cancelarla:");
    return;
  }

  // Buscar por número o por nombre
  const num = parseInt(texto) - 1;
  let doctorIdx = -1;

  if (!isNaN(num) && num >= 0 && num < DOCTORES.length) {
    doctorIdx = num;
  } else {
    doctorIdx = DOCTORES.findIndex(d =>
      d.nombre.toLowerCase().includes(texto.toLowerCase())
    );
  }

  if (doctorIdx === -1) {
    const botones = DOCTORES.map((d, i) => [`${i + 1}. ${d.nombre}`]);
    await enviarConBotones(chatId, "No reconocí esa opción. Elige un número:", botones);
    return;
  }

  const doctor = DOCTORES[doctorIdx]!;
  const nuevaSesion: BotSesion = {
    ...sesion,
    paso:          "elegir_sede",
    doctor_nombre: doctor.nombre,
  };
  await setSesion(chatId, nuevaSesion);

  const botones = doctor.sedes.map((s, i) => [`${i + 1}. ${s.ciudad} — ${s.nombre}`]);
  await enviarConBotones(
    chatId,
    `✅ *${doctor.nombre}*\n\n📍 ¿En qué sede deseas la cita?`,
    botones,
  );
}

// ── ELEGIR SEDE ──────────────────────────────────────────────
async function manejarSede(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const doctor = DOCTORES.find(d => d.nombre === sesion.doctor_nombre);
  if (!doctor) { await mostrarInicio(chatId); return; }

  const num = parseInt(texto) - 1;
  let sedeIdx = -1;

  if (!isNaN(num) && num >= 0 && num < doctor.sedes.length) {
    sedeIdx = num;
  } else {
    sedeIdx = doctor.sedes.findIndex(s =>
      s.ciudad.toLowerCase().includes(texto.toLowerCase()) ||
      s.nombre.toLowerCase().includes(texto.toLowerCase())
    );
  }

  if (sedeIdx === -1) {
    const botones = doctor.sedes.map((s, i) => [`${i + 1}. ${s.ciudad}`]);
    await enviarConBotones(chatId, "No reconocí esa sede. Elige un número:", botones);
    return;
  }

  const sede = doctor.sedes[sedeIdx]!;
  await setSesion(chatId, {
    ...sesion,
    paso:       "tipo_consulta",
    sede_id:    sede.dc_id,
    sede_nombre: `${sede.nombre} (${sede.ciudad})`,
  });

  await enviarConBotones(
    chatId,
    `✅ Sede: *${sede.nombre}*\n\n¿Es tu primera vez con el doctor?`,
    [["✅ Sí, primera vez"], ["🔄 No, es seguimiento"]],
  );
}

// ── TIPO CONSULTA ────────────────────────────────────────────
async function manejarTipoConsulta(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const tipo = await interpretarTipoConsulta(texto);

  if (!tipo) {
    await enviarConBotones(
      chatId,
      "No entendí tu respuesta. ¿Es primera vez o seguimiento?",
      [["✅ Sí, primera vez"], ["🔄 No, es seguimiento"]],
    );
    return;
  }

  const doctor = DOCTORES.find(d => d.nombre === sesion.doctor_nombre);
  const sede   = doctor?.sedes.find(s => s.dc_id === sesion.sede_id);
  if (!sede) { await mostrarInicio(chatId); return; }

  const servicioId = tipo === "primera" ? sede.servicios.primera_vez : sede.servicios.seguimiento;

  await setSesion(chatId, {
    ...sesion,
    paso:        "nombre",
    es_primera:  tipo === "primera",
    servicio_id: servicioId,
  });

  await quitarTeclado(chatId, "📝 ¿Cuál es tu *nombre completo*?");
}

// ── NOMBRE ───────────────────────────────────────────────────
async function manejarNombre(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const nombre = await extraerNombre(texto);

  if (!nombre) {
    await enviar(chatId, "No pude identificar tu nombre. Por favor escribe tu *nombre y apellido*:");
    return;
  }

  await setSesion(chatId, { ...sesion, paso: "telefono", nombre });
  await enviar(chatId, `✅ *${nombre}*\n\n📞 ¿Cuál es tu número de teléfono? (ej: 8091234567)`);
}

// ── TELÉFONO ─────────────────────────────────────────────────
async function manejarTelefono(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const telRaw = await extraerTelefono(texto);

  if (!telRaw) {
    await enviar(chatId, "❌ No pude identificar el número. Escríbelo así: *8091234567*");
    return;
  }

  const telefono = normalizeTelefono(telRaw);
  await setSesion(chatId, { ...sesion, paso: "motivo", telefono });
  await enviar(chatId, "🩺 ¿Cuál es el *motivo* de tu consulta?");
}

// ── MOTIVO ───────────────────────────────────────────────────
async function manejarMotivo(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  await setSesion(chatId, { ...sesion, paso: "elegir_dia", motivo: texto });
  await enviar(chatId, "🔍 Buscando disponibilidad...");

  // Buscar días disponibles
  const result = await rpc<any>("fn_dias_disponibles", {
    p_doctor_clinica_id: sesion.sede_id,
    p_servicio_id:       sesion.servicio_id,
    p_dias_adelante:     14,
    p_max_resultados:    6,
  });

  const dias = result.data ?? [];

  if (dias.length === 0) {
    await enviar(
      chatId,
      "😔 No hay citas disponibles en los próximos 14 días para esta sede.\n\nEscribe /start para intentar en otra sede.",
    );
    await deleteSesion(chatId);
    return;
  }

  await setSesion(chatId, { ...sesion, paso: "elegir_dia", motivo: texto, dias_disponibles: dias });

  const botones = dias.map((d: any, i: number) => [`${i + 1}. ${formatFecha(d.fecha)} — ${d.total_slots} horarios`]);
  await enviarConBotones(chatId, "📅 *Días disponibles:*\n\nElige el número del día:", botones);
}

// ── ELEGIR DÍA ───────────────────────────────────────────────
async function manejarElegirDia(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const dias = sesion.dias_disponibles ?? [];
  const num  = parseInt(texto) - 1;

  if (isNaN(num) || num < 0 || num >= dias.length) {
    const botones = dias.map((d: any, i: number) => [`${i + 1}. ${formatFecha(d.fecha)}`]);
    await enviarConBotones(chatId, `Opción no válida. Elige entre 1 y ${dias.length}:`, botones);
    return;
  }

  const fechaSel = dias[num]!.fecha;
  await enviar(chatId, `⏰ Buscando horarios para *${formatFecha(fechaSel)}*...`);

  const result = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: sesion.sede_id,
    p_fecha:             fechaSel,
    p_servicio_id:       sesion.servicio_id,
  });

  const slotsRaw = result.data ?? [];

  if (slotsRaw.length === 0) {
    await enviar(chatId, "😔 Ese día ya no tiene horarios. Escribe /start para intentar otro día.");
    await deleteSesion(chatId);
    return;
  }

  // Tomar máximo 8 slots y formatear hora
  const slots = slotsRaw.slice(0, 8).map((s: any) => ({
    inicia_en: s.inicia_en,
    hora:      toLocalTime(s.inicia_en),
  }));

  await setSesion(chatId, { ...sesion, paso: "elegir_hora", fecha_sel: fechaSel, slots });

  const botones = slots.map((s: any, i: number) => [`${i + 1}. ${s.hora}`]);
  await enviarConBotones(chatId, "⏰ *Horarios disponibles:*\n\nElige el número:", botones);
}

// ── ELEGIR HORA ──────────────────────────────────────────────
async function manejarElegirHora(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const slots = sesion.slots ?? [];
  const num   = parseInt(texto) - 1;

  if (isNaN(num) || num < 0 || num >= slots.length) {
    const botones = slots.map((s: any, i: number) => [`${i + 1}. ${s.hora}`]);
    await enviarConBotones(chatId, `Hora no válida. Elige entre 1 y ${slots.length}:`, botones);
    return;
  }

  const slotSel = slots[num]!;
  await setSesion(chatId, { ...sesion, paso: "confirmar", slot_sel: slotSel });

  const tipoTxt = sesion.es_primera ? "Primera vez" : "Seguimiento";
  await enviarConBotones(
    chatId,
    `📋 *CONFIRMA TU CITA:*\n\n` +
    `👤 ${sesion.nombre}\n` +
    `📞 ${sesion.telefono}\n` +
    `🏥 ${sesion.sede_nombre}\n` +
    `📅 ${formatFecha(sesion.fecha_sel!)} a las ${slotSel.hora}\n` +
    `🩺 ${sesion.motivo}\n` +
    `📋 ${tipoTxt}\n\n` +
    `¿Todo correcto?`,
    [["✅ Confirmar"], ["❌ Cancelar"]],
  );
}

// ── CONFIRMAR ────────────────────────────────────────────────
async function manejarConfirmar(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const respuesta = await interpretarConfirmacion(texto);

  if (respuesta === null) {
    await enviarConBotones(chatId, "No entendí. ¿Confirmas la cita?", [["✅ Confirmar"], ["❌ Cancelar"]]);
    return;
  }

  if (respuesta === "no") {
    await deleteSesion(chatId);
    await enviar(chatId, "Cita cancelada. Escribe /start para comenzar de nuevo.");
    return;
  }

  // Crear paciente y agendar
  await quitarTeclado(chatId, "⏳ Agendando tu cita...");

  const nombreParts = (sesion.nombre ?? "Paciente").split(" ");
  const nombre  = nombreParts[0] ?? "Paciente";
  const apellido = nombreParts.slice(1).join(" ") || "Paciente";

  const pac = await rpc<any>("fn_get_or_create_paciente", {
    p_telefono:         sesion.telefono,
    p_nombre:           nombre,
    p_apellido:         apellido,
    p_cedula:           null,
    p_fecha_nacimiento: null,
    p_sexo:             null,
    p_zona:             null,
  });

  if (!pac.data?.[0]?.paciente_id) {
    await enviar(chatId, "❌ Error al procesar tus datos. Intenta de nuevo con /start");
    await deleteSesion(chatId);
    return;
  }

  const cita = await rpc<any>("fn_agendar_cita", {
    p_doctor_clinica_id: sesion.sede_id,
    p_paciente_id:       pac.data[0].paciente_id,
    p_servicio_id:       sesion.servicio_id,
    p_inicia_en:         sesion.slot_sel?.inicia_en,
    p_motivo:            sesion.motivo,
    p_canal:             "telegram",
    p_creado_por:        null,
  });

  await deleteSesion(chatId);

  if (!cita.data?.[0]?.exito) {
    const msg = cita.data?.[0]?.mensaje ?? "Horario no disponible.";
    await enviar(chatId, `❌ ${msg}\n\nEscribe /start para intentar otro horario.`);
    return;
  }

  const codigo = cita.data[0].codigo;
  await enviar(
    chatId,
    `✅ *¡CITA CONFIRMADA!*\n\n` +
    `📋 Código: *${codigo}*\n` +
    `🏥 ${sesion.sede_nombre}\n` +
    `📅 ${formatFecha(sesion.fecha_sel!)}\n` +
    `⏰ ${sesion.slot_sel?.hora}\n` +
    `👤 ${sesion.nombre}\n\n` +
    `_Guarda este código. Para cancelar escríbelo aquí o usa /cancelar_`,
  );
}

// ── CANCELAR CITA EXISTENTE ──────────────────────────────────
async function manejarCancelarCita(chatId: string, texto: string): Promise<void> {
  let codigo = texto.toUpperCase().trim();
  if (!codigo.startsWith("CITA-")) codigo = "CITA-" + codigo;

  const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    codigo: `eq.${codigo}`,
    select: "id,estado,inicia_en,pacientes(nombre,apellido)",
    limit:  "1",
  });

  if (!found.data?.[0]) {
    await enviar(chatId, `❌ No encontré ninguna cita con el código *${codigo}*.\n\nVerifica el código e intenta de nuevo, o escribe /start para agendar una nueva.`);
    await deleteSesion(chatId);
    return;
  }

  const c      = found.data[0];
  const estado = c.estado;

  if (!["pendiente","confirmada"].includes(estado)) {
    await enviar(chatId, `ℹ️ La cita *${codigo}* ya está en estado _${estado}_ y no puede cancelarse.\n\nEscribe /start para agendar una nueva.`);
    await deleteSesion(chatId);
    return;
  }

  const result = await rpc<any>("fn_cancelar_cita", {
    p_cita_id:            c.id,
    p_motivo_cancel:      "cancelada_paciente",
    p_cancelado_por:      null,
    p_penalizar_paciente: null,
  });

  await deleteSesion(chatId);

  if (result.data?.[0]?.exito) {
    const hora = toLocalTime(c.inicia_en);
    await enviar(
      chatId,
      `✅ Cita *${codigo}* cancelada correctamente.\n` +
      `⏰ Hora que tenías: ${hora}\n\n` +
      `Escribe /start si deseas agendar una nueva cita.`,
    );
  } else {
    await enviar(chatId, "❌ No se pudo cancelar. Intenta de nuevo o llama directamente.");
  }
}
