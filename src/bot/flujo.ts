import { BotSesion } from "./types.js";
import { DOCTORES } from "./config.js";
import { getSesion, setSesion, deleteSesion } from "./sesion.js";
import { enviar, enviarConBotones, quitarTeclado } from "./telegram.js";
import { rpc, supabase } from "../lib/supabase.js";
import { normalizeTelefono } from "../lib/dates.js";
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
  const d = new Date(fecha + "T12:00:00Z");
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth() + 1]}`;
}

function toHoraRD(isoUtc: string): string {
  const dt = new Date(isoUtc);
  return dt.toLocaleTimeString("es-DO", {
    timeZone: "America/Santo_Domingo",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export async function procesarMensaje(chatId: string, texto: string): Promise<void> {
  const textoLower = texto.toLowerCase().trim();

  if (texto === "/start" || textoLower === "hola" || textoLower === "inicio" || textoLower === "menu") {
    await deleteSesion(chatId);
    await mostrarInicio(chatId);
    return;
  }

  if (texto === "/cancelar" || textoLower === "cancelar cita") {
    const sesion = await getSesion(chatId);
    await setSesion(chatId, { ...sesion, paso: "cancelar_cita" });
    await enviar(chatId, "🔍 Sin problema, dime el *código* de tu cita (ej: CITA-A3B9K2) y yo me encargo:");
    return;
  }

  const quiereCancelar = await detectarIntencionCancelar(texto);
  if (quiereCancelar) {
    const sesion = await getSesion(chatId);
    await setSesion(chatId, { ...sesion, paso: "cancelar_cita" });
    await enviar(chatId, "🔍 Claro, dime el *código* de tu cita y la cancelo ahora mismo:");
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

async function mostrarInicio(chatId: string): Promise<void> {
  const lista = DOCTORES.map((d, i) => `${i + 1}️⃣ *${d.nombre}* — ${d.especialidad}`).join("\n");
  const botones = DOCTORES.map((d, i) => [`${i + 1}. ${d.nombre}`]);
  botones.push(["❌ Cancelar una cita"]);

  await enviarConBotones(
    chatId,
    `👋 ¡Hola! Soy el asistente de citas médicas.\n\n¿Con qué doctor te puedo ayudar hoy?\n\n${lista}\n\nEscribe el número o toca una opción 👇`,
    botones,
  );
  await setSesion(chatId, { paso: "elegir_doctor" });
}

async function manejarInicio(chatId: string, _texto: string, _sesion: BotSesion): Promise<void> {
  await mostrarInicio(chatId);
}

async function manejarDoctor(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  if (texto.toLowerCase().includes("cancelar una cita")) {
    await setSesion(chatId, { ...sesion, paso: "cancelar_cita" });
    await enviar(chatId, "🔍 Dime el *código* de tu cita y la cancelo ahora mismo:");
    return;
  }

  const num = parseInt(texto) - 1;
  let doctorIdx = -1;
  if (!isNaN(num) && num >= 0 && num < DOCTORES.length) {
    doctorIdx = num;
  } else {
    doctorIdx = DOCTORES.findIndex(d => d.nombre.toLowerCase().includes(texto.toLowerCase()));
  }

  if (doctorIdx === -1) {
    const lista = DOCTORES.map((d, i) => `${i + 1}️⃣ *${d.nombre}*`).join("\n");
    const botones = DOCTORES.map((d, i) => [`${i + 1}. ${d.nombre}`]);
    await enviarConBotones(chatId, `No reconocí esa opción 😅\n\n${lista}\n\nEscribe el número:`, botones);
    return;
  }

  const doctor = DOCTORES[doctorIdx]!;
  await setSesion(chatId, { ...sesion, paso: "elegir_sede", doctor_nombre: doctor.nombre });

  const lista = doctor.sedes.map((s, i) => `${i + 1}️⃣ ${s.ciudad} — ${s.nombre}`).join("\n");
  const botones = doctor.sedes.map((s, i) => [`${i + 1}. ${s.ciudad}`]);
  await enviarConBotones(chatId, `✅ *${doctor.nombre}*\n\n📍 ¿En qué sede te queda mejor?\n\n${lista}\n\nEscribe el número 👇`, botones);
}

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
    const lista = doctor.sedes.map((s, i) => `${i + 1}️⃣ ${s.ciudad}`).join("\n");
    const botones = doctor.sedes.map((s, i) => [`${i + 1}. ${s.ciudad}`]);
    await enviarConBotones(chatId, `No reconocí esa sede 😅\n\n${lista}\n\nEscribe el número:`, botones);
    return;
  }

  const sede = doctor.sedes[sedeIdx]!;
  await setSesion(chatId, { ...sesion, paso: "tipo_consulta", sede_id: sede.dc_id, sede_nombre: `${sede.nombre} (${sede.ciudad})` });
  await enviarConBotones(
    chatId,
    `✅ *${sede.nombre}*\n\n¿Es tu primera vez con el doctor o es seguimiento?\n\n1️⃣ Primera vez\n2️⃣ Seguimiento`,
    [["1. Primera vez"], ["2. Seguimiento"]],
  );
}

async function manejarTipoConsulta(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const tipo = await interpretarTipoConsulta(texto);
  if (!tipo) {
    await enviarConBotones(
      chatId,
      "No entendí bien 😅\n\n1️⃣ Primera vez\n2️⃣ Seguimiento\n\nEscribe el número:",
      [["1. Primera vez"], ["2. Seguimiento"]],
    );
    return;
  }

  const doctor = DOCTORES.find(d => d.nombre === sesion.doctor_nombre);
  const sede   = doctor?.sedes.find(s => s.dc_id === sesion.sede_id);
  if (!sede) { await mostrarInicio(chatId); return; }

  const servicioId = tipo === "primera" ? sede.servicios.primera_vez : sede.servicios.seguimiento;
  await setSesion(chatId, { ...sesion, paso: "nombre", es_primera: tipo === "primera", servicio_id: servicioId });
  await quitarTeclado(chatId, "📝 ¿Cuál es tu nombre completo?");
}

async function manejarNombre(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const nombre = await extraerNombre(texto);
  if (!nombre) {
    await enviar(chatId, "No pude identificar tu nombre 😅 Escribe tu *nombre y apellido* completo:");
    return;
  }
  await setSesion(chatId, { ...sesion, paso: "telefono", nombre });
  await enviar(chatId, `Perfecto, *${nombre}* 👍\n\n📞 ¿Cuál es tu número de teléfono? (ej: 8091234567)`);
}

async function manejarTelefono(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const telRaw = await extraerTelefono(texto);
  if (!telRaw) {
    await enviar(chatId, "❌ No pude leer el número. Escríbelo así: *8091234567*");
    return;
  }
  const telefono = normalizeTelefono(telRaw);
  await setSesion(chatId, { ...sesion, paso: "motivo", telefono });
  await enviar(chatId, "🩺 ¿Cuál es el motivo de tu consulta?\n\n_(Escríbelo con tus propias palabras)_");
}

async function manejarMotivo(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  await setSesion(chatId, { ...sesion, paso: "elegir_dia", motivo: texto });
  await enviar(chatId, "🔍 Buscando los mejores horarios disponibles para ti...");

  const result = await rpc<any>("fn_dias_disponibles", {
    p_doctor_clinica_id: sesion.sede_id,
    p_servicio_id:       sesion.servicio_id,
    p_dias_adelante:     14,
    p_max_resultados:    6,
  });

  const dias = result.data ?? [];
  if (dias.length === 0) {
    await enviar(chatId, "😔 No hay citas disponibles en los próximos 14 días.\n\nEscribe /start para intentar en otra sede.");
    await deleteSesion(chatId);
    return;
  }

  await setSesion(chatId, { ...sesion, paso: "elegir_dia", motivo: texto, dias_disponibles: dias });
  const lista = dias.map((d: any, i: number) => `${i + 1}️⃣ ${formatFecha(d.fecha)} — ${d.total_slots} horarios`).join("\n");
  const botones = dias.map((d: any, i: number) => [`${i + 1}. ${formatFecha(d.fecha)}`]);
  await enviarConBotones(chatId, `📅 Estos son los días disponibles:\n\n${lista}\n\n¿Cuál te viene mejor? Escribe el número 👇`, botones);
}

async function manejarElegirDia(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const dias = sesion.dias_disponibles ?? [];
  const num  = parseInt(texto) - 1;

  if (isNaN(num) || num < 0 || num >= dias.length) {
    const lista = dias.map((d: any, i: number) => `${i + 1}️⃣ ${formatFecha(d.fecha)}`).join("\n");
    const botones = dias.map((d: any, i: number) => [`${i + 1}. ${formatFecha(d.fecha)}`]);
    await enviarConBotones(chatId, `Elige un número del 1 al ${dias.length}:\n\n${lista}`, botones);
    return;
  }

  const fechaSel = dias[num]!.fecha;
  await enviar(chatId, `⏰ Revisando horarios para *${formatFecha(fechaSel)}*...`);

  const result = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: sesion.sede_id,
    p_fecha:             fechaSel,
    p_servicio_id:       sesion.servicio_id,
  });

  const slotsRaw = result.data ?? [];
  if (slotsRaw.length === 0) {
    await enviar(chatId, "😔 Ese día ya no tiene horarios.\n\nEscribe /start para elegir otro día.");
    await deleteSesion(chatId);
    return;
  }

  const slots = slotsRaw.slice(0, 8).map((s: any) => ({ inicia_en: s.inicia_en, hora: toHoraRD(s.inicia_en) }));
  await setSesion(chatId, { ...sesion, paso: "elegir_hora", fecha_sel: fechaSel, slots });

  const lista = slots.map((s: any, i: number) => `${i + 1}️⃣ ${s.hora}`).join("\n");
  const botones = slots.map((s: any, i: number) => [`${i + 1}. ${s.hora}`]);
  await enviarConBotones(chatId, `⏰ Horarios disponibles para *${formatFecha(fechaSel)}*:\n\n${lista}\n\nElige el que te funcione mejor 😉`, botones);
}

async function manejarElegirHora(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const slots = sesion.slots ?? [];
  const num   = parseInt(texto) - 1;

  if (isNaN(num) || num < 0 || num >= slots.length) {
    const lista = slots.map((s: any, i: number) => `${i + 1}️⃣ ${s.hora}`).join("\n");
    const botones = slots.map((s: any, i: number) => [`${i + 1}. ${s.hora}`]);
    await enviarConBotones(chatId, `Elige un número del 1 al ${slots.length}:\n\n${lista}`, botones);
    return;
  }

  const slotSel = slots[num]!;
  await setSesion(chatId, { ...sesion, paso: "confirmar", slot_sel: slotSel });

  await enviarConBotones(
    chatId,
    `📋 *Revisa tu cita antes de confirmar:*\n\n` +
    `👤 ${sesion.nombre}\n` +
    `📞 ${sesion.telefono}\n` +
    `🏥 ${sesion.sede_nombre}\n` +
    `📅 ${formatFecha(sesion.fecha_sel!)} a las *${slotSel.hora}*\n` +
    `🩺 ${sesion.motivo}\n` +
    `📋 ${sesion.es_primera ? "Primera vez" : "Seguimiento"}\n\n` +
    `¿Todo está bien? 👇`,
    [["✅ Sí, confirmar"], ["❌ Cancelar"]],
  );
}

async function manejarConfirmar(chatId: string, texto: string, sesion: BotSesion): Promise<void> {
  const respuesta = await interpretarConfirmacion(texto);

  if (respuesta === null) {
    await enviarConBotones(chatId, "¿Confirmamos la cita? 👇", [["✅ Sí, confirmar"], ["❌ Cancelar"]]);
    return;
  }

  if (respuesta === "no") {
    await deleteSesion(chatId);
    await enviar(chatId, "Sin problema 👍 Escribe /start cuando quieras intentar de nuevo.");
    return;
  }

  await quitarTeclado(chatId, "⏳ Agendando tu cita, un momento...");

  const nombreParts = (sesion.nombre ?? "Paciente").split(" ");
  const nombre   = nombreParts[0] ?? "Paciente";
  const apellido = nombreParts.slice(1).join(" ") || "Paciente";

  const pac = await rpc<any>("fn_get_or_create_paciente", {
    p_telefono: sesion.telefono, p_nombre: nombre, p_apellido: apellido,
    p_cedula: null, p_fecha_nacimiento: null, p_sexo: null, p_zona: null,
  });

  if (!pac.data?.[0]?.paciente_id) {
    await enviar(chatId, "❌ Hubo un problema. Intenta de nuevo con /start");
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
    const msg = cita.data?.[0]?.mensaje ?? "Ese horario ya no está disponible.";
    await enviar(chatId, `❌ ${msg}\n\nEscribe /start para elegir otro horario.`);
    return;
  }

  await enviar(chatId,
    `✅ *¡CITA CONFIRMADA!* 🎉\n\n` +
    `📋 Código: *${cita.data[0].codigo}*\n` +
    `🏥 ${sesion.sede_nombre}\n` +
    `📅 ${formatFecha(sesion.fecha_sel!)}\n` +
    `⏰ ${sesion.slot_sel?.hora}\n` +
    `👤 ${sesion.nombre}\n\n` +
    `_Guarda ese código. Para cancelar escríbelo aquí o usa /cancelar_ 😊`,
  );
}

async function manejarCancelarCita(chatId: string, texto: string): Promise<void> {
  let codigo = texto.toUpperCase().trim();
  if (!codigo.startsWith("CITA-")) codigo = "CITA-" + codigo;

  const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    codigo: `eq.${codigo}`, select: "id,estado,inicia_en", limit: "1",
  });

  if (!found.data?.[0]) {
    await enviar(chatId, `❌ No encontré la cita *${codigo}*.\n\nVerifica el código o escribe /start para agendar una nueva.`);
    await deleteSesion(chatId);
    return;
  }

  const c = found.data[0];
  if (!["pendiente","confirmada"].includes(c.estado)) {
    await enviar(chatId, `ℹ️ La cita *${codigo}* ya está en estado _${c.estado}_.\n\nEscribe /start si deseas agendar una nueva.`);
    await deleteSesion(chatId);
    return;
  }

  const result = await rpc<any>("fn_cancelar_cita", {
    p_cita_id: c.id, p_motivo_cancel: "cancelada_paciente",
    p_cancelado_por: null, p_penalizar_paciente: null,
  });

  await deleteSesion(chatId);

  if (result.data?.[0]?.exito) {
    await enviar(chatId,
      `✅ Listo, cita *${codigo}* cancelada.\n` +
      `⏰ Tenías tu cita a las ${toHoraRD(c.inicia_en)}\n\n` +
      `Escribe /start cuando quieras agendar una nueva 😊`,
    );
  } else {
    await enviar(chatId, "❌ No se pudo cancelar. Intenta de nuevo o llama directamente.");
  }
}
