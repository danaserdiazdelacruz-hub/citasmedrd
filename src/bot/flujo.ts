import { getSesion, setSesion, deleteSesion } from "./sesion.js";
import { enviar } from "./telegram.js";
import { rpc, supabase } from "../lib/supabase.js";
import { normalizeTelefono } from "../lib/dates.js";
import { ENV } from "../lib/env.js";
import { DOCTORES } from "./config.js";
import { BotSesion } from "./types.js";

const DIAS  = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const MESES = ["","ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

function formatFecha(fecha: string): string {
  const d = new Date(fecha + "T12:00:00Z");
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth() + 1]}`;
}

function toHoraRD(isoUtc: string): string {
  return new Date(isoUtc).toLocaleTimeString("es-DO", {
    timeZone: "America/Santo_Domingo",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function fechaHoyRD(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Santo_Domingo" });
}

function buildSystemPrompt(sesion: BotSesion): string {
  const hoy = fechaHoyRD();
  const manana = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: "America/Santo_Domingo" });

  return `Eres la recepcionista virtual del consultorio del Dr. Hairol Pérez (Oncología/Ginecología).
Te llamas "Asistente CitasMed". Eres cálida, natural, eficiente. Hablas como una dominicana real.
Usas emojis con moderación. Eres concisa — máximo 4 líneas por respuesta.

HOY ES: ${hoy} | MAÑANA: ${manana}

SEDES DISPONIBLES:
1. Santo Domingo — Centro Médico María Dolores
2. San Pedro de Macorís — Unidad Oncológica del Este  
3. Jimaní — Centro Médico Doctor Paulino

TIPOS DE CONSULTA:
- Primera vez / primera consulta / nueva
- Seguimiento / control / revisión

TU TRABAJO: Agendar citas de forma natural, como una conversación real.
Recopila: sede, tipo de consulta, nombre, teléfono, motivo.
Ve paso a paso — no preguntes todo de golpe.

USA FRASES COMO: "Claro que sí", "Con gusto", "Déjame ver...", "Te agendo", "Sin problema"

ESTADO ACTUAL:
- Nombre: ${sesion.nombre ?? "no recogido"}
- Teléfono: ${sesion.telefono ?? "no recogido"}
- Sede: ${sesion.sede_nombre ?? "no seleccionada"}
- Tipo: ${sesion.es_primera === undefined ? "no definido" : sesion.es_primera ? "Primera vez" : "Seguimiento"}
- Motivo: ${sesion.motivo ?? "no indicado"}
- Horarios mostrados: ${sesion.slots_disponibles ?? "ninguno aún"}

CUANDO TENGAS sede + tipo de consulta: incluye exactamente [BUSCAR_SLOTS] en tu respuesta.
CUANDO EL PACIENTE CONFIRME una cita específica con horario ya mostrado: incluye [AGENDAR] en tu respuesta.
CUANDO pidan cancelar: pide el código y luego incluye [CANCELAR codigo=XXXX].`;
}

async function llamarClaude(historial: {role: string; content: string}[], system: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ENV.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system,
      messages: historial,
    }),
  });
  if (!res.ok) return "Disculpa, tuve un problema. ¿Puedes repetirlo?";
  const data = await res.json() as { content?: { text?: string }[] };
  return data.content?.[0]?.text?.trim() ?? "Disculpa, no pude procesar tu mensaje.";
}

async function extraerDatos(texto: string): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ENV.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `Extrae datos del mensaje. Responde SOLO JSON sin explicaciones.
Campos: nombre (string), telefono (solo dígitos), motivo (string), 
es_primera (true=primera vez, false=seguimiento), sede_ciudad (Santo Domingo|San Pedro|Jimaní)
Solo incluye campos que encuentres claramente.`,
      messages: [{ role: "user", content: texto }],
    }),
  });
  try {
    const data = await res.json() as { content?: { text?: string }[] };
    const text = data.content?.[0]?.text?.trim() ?? "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch { return {}; }
}

function resolverSede(ciudad: string) {
  for (const doc of DOCTORES) {
    const sede = doc.sedes.find(s =>
      ciudad.toLowerCase().includes(s.ciudad.toLowerCase().split(" ")[0]!) ||
      s.ciudad.toLowerCase().includes(ciudad.toLowerCase())
    );
    if (sede) return sede;
  }
  return null;
}

async function buscarYMostrarSlots(sesion: BotSesion, fecha: string): Promise<{texto: string; slots: any[]}> {
  const result = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: sesion.sede_id,
    p_fecha: fecha,
    p_servicio_id: sesion.servicio_id,
  });
  const slots = (result.data ?? []).slice(0, 8).map((s: any, i: number) => ({
    num: i + 1, hora: toHoraRD(s.inicia_en), inicia_en: s.inicia_en,
  }));
  if (slots.length === 0) return { texto: "No hay horarios disponibles para ese día.", slots: [] };
  const texto = slots.map((s: any) => `${s.num}️⃣ ${s.hora}`).join("\n");
  return { texto, slots };
}

export async function procesarMensaje(chatId: string, texto: string): Promise<void> {
  let sesion = await getSesion(chatId);
  const historial: {role: string; content: string}[] = (sesion.historial as any) ?? [];

  // Reset con /start o hola
  const tl = texto.toLowerCase().trim();
  if (texto === "/start" || tl === "hola" || tl === "buenas" || tl === "buenos días" || tl === "buenas tardes") {
    await deleteSesion(chatId);
    sesion = {};
    historial.length = 0;
  }

  // Extraer datos del mensaje
  const datos = await extraerDatos(texto);

  if (datos.nombre && !sesion.nombre) sesion.nombre = datos.nombre;
  if (datos.telefono && !sesion.telefono) sesion.telefono = normalizeTelefono(datos.telefono);
  if (datos.motivo && !sesion.motivo) sesion.motivo = datos.motivo;
  if (datos.es_primera !== undefined && sesion.es_primera === undefined) sesion.es_primera = datos.es_primera;

  if (datos.sede_ciudad && !sesion.sede_id) {
    const sede = resolverSede(datos.sede_ciudad);
    if (sede) {
      sesion.sede_id = sede.dc_id;
      sesion.sede_nombre = `${sede.nombre} (${sede.ciudad})`;
    }
  }

  // Resolver servicio si tenemos sede + tipo
  if (sesion.sede_id && sesion.es_primera !== undefined && !sesion.servicio_id) {
    for (const doc of DOCTORES) {
      const sede = doc.sedes.find(s => s.dc_id === sesion.sede_id);
      if (sede) {
        sesion.servicio_id = sesion.es_primera ? sede.servicios.primera_vez : sede.servicios.seguimiento;
        break;
      }
    }
  }

  // Si está eligiendo día (número)
  if (sesion.paso === "elegir_dia" && sesion.dias_disponibles) {
    const num = parseInt(texto) - 1;
    if (!isNaN(num) && num >= 0 && num < sesion.dias_disponibles.length) {
      const fechaSel = sesion.dias_disponibles[num]!.fecha;
      const { texto: slotsTexto, slots } = await buscarYMostrarSlots(sesion, fechaSel);
      sesion.fecha_sel = fechaSel;
      sesion.slots = slots;
      sesion.slots_disponibles = slotsTexto;
      sesion.paso = "elegir_hora";
      const resp = `Claro, para el *${formatFecha(fechaSel)}* tengo estos horarios:\n\n${slotsTexto}\n\n¿Cuál te queda mejor?`;
      historial.push({ role: "user", content: texto });
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20) as any;
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }
  }

  // Si está eligiendo hora (número) y tenemos todo para agendar
  if (sesion.paso === "elegir_hora" && sesion.slots && sesion.nombre && sesion.telefono) {
    const num = parseInt(texto) - 1;
    if (!isNaN(num) && num >= 0 && num < sesion.slots.length) {
      const slot = sesion.slots[num]!;

      const nombreParts = sesion.nombre.split(" ");
      const pac = await rpc<any>("fn_get_or_create_paciente", {
        p_telefono: sesion.telefono,
        p_nombre: nombreParts[0] ?? "Paciente",
        p_apellido: nombreParts.slice(1).join(" ") || "Paciente",
        p_cedula: null, p_fecha_nacimiento: null, p_sexo: null, p_zona: null,
      });

      if (!pac.data?.[0]?.paciente_id) {
        await enviar(chatId, "❌ Hubo un problema. Intenta de nuevo con /start");
        return;
      }

      const cita = await rpc<any>("fn_agendar_cita", {
        p_doctor_clinica_id: sesion.sede_id,
        p_paciente_id: pac.data[0].paciente_id,
        p_servicio_id: sesion.servicio_id,
        p_inicia_en: slot.inicia_en,
        p_motivo: sesion.motivo ?? "Consulta médica",
        p_canal: "telegram",
        p_creado_por: null,
      });

      await deleteSesion(chatId);

      if (!cita.data?.[0]?.exito) {
        await enviar(chatId, `❌ ${cita.data?.[0]?.mensaje ?? "Ese horario ya no está disponible."}\n\nEscribe /start para intentar de nuevo.`);
        return;
      }

      await enviar(chatId,
        `¡Listo! 🙌 Te agendo a las *${slot.hora}*\n\n` +
        `✅ *Cita confirmada* 🗓️\n` +
        `📅 ${formatFecha(sesion.fecha_sel!)}\n` +
        `⏰ ${slot.hora}\n` +
        `👤 ${sesion.nombre}\n` +
        `🏥 ${sesion.sede_nombre}\n` +
        `📋 Código: *${cita.data[0].codigo}*\n\n` +
        `Si necesitas cancelar o tienes alguna duda, escríbeme. ¡Te esperamos! 😊`
      );
      return;
    }
  }

  // Claude maneja la conversación
  historial.push({ role: "user", content: texto });
  const system = buildSystemPrompt(sesion);
  let respuesta = await llamarClaude(historial, system);

  // Procesar [BUSCAR_SLOTS]
  if (respuesta.includes("[BUSCAR_SLOTS]") && sesion.sede_id && sesion.servicio_id) {
    respuesta = respuesta.replace("[BUSCAR_SLOTS]", "").trim();
    const diasResult = await rpc<any>("fn_dias_disponibles", {
      p_doctor_clinica_id: sesion.sede_id,
      p_servicio_id: sesion.servicio_id,
      p_dias_adelante: 14,
      p_max_resultados: 5,
    });
    const dias = diasResult.data ?? [];
    if (dias.length === 0) {
      respuesta += "\n\n😔 No hay citas disponibles en los próximos 14 días. Prueba otra sede.";
    } else {
      sesion.dias_disponibles = dias;
      sesion.paso = "elegir_dia";
      const lista = dias.map((d: any, i: number) =>
        `${i + 1}️⃣ ${formatFecha(d.fecha)} — ${d.total_slots} horarios`
      ).join("\n");
      respuesta += `\n\n${lista}\n\n¿Para cuál día te agendo?`;
    }
  }

  // Procesar [CANCELAR codigo=XXX]
  const matchCancelar = respuesta.match(/\[CANCELAR codigo=([A-Z0-9-]+)\]/);
  if (matchCancelar) {
    respuesta = respuesta.replace(matchCancelar[0], "").trim();
    let codigo = matchCancelar[1]!.toUpperCase();
    if (!codigo.startsWith("CITA-")) codigo = "CITA-" + codigo;
    const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
      codigo: `eq.${codigo}`, select: "id,estado", limit: "1",
    });
    if (found.data?.[0] && ["pendiente","confirmada"].includes(found.data[0].estado)) {
      await rpc<any>("fn_cancelar_cita", {
        p_cita_id: found.data[0].id, p_motivo_cancel: "cancelada_paciente",
        p_cancelado_por: null, p_penalizar_paciente: null,
      });
      respuesta += `\n\n✅ Cita *${codigo}* cancelada correctamente.`;
      await deleteSesion(chatId);
    } else {
      respuesta += `\n\n❌ No encontré una cita activa con el código *${codigo}*.`;
    }
  }

  historial.push({ role: "assistant", content: respuesta });
  sesion.historial = historial.slice(-20) as any;
  await setSesion(chatId, sesion);
  await enviar(chatId, respuesta);
}
