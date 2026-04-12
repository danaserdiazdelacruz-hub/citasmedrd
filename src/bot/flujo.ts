import { getSesion, setSesion, deleteSesion } from "./sesion.js";
import { enviar } from "./telegram.js";
import { rpc, supabase } from "../lib/supabase.js";
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

function validarTelefonoRD(tel: string): string | null {
  const digits = tel.replace(/\D/g, "");
  let numero = digits;
  if (numero.length === 11 && numero.startsWith("1")) numero = numero.slice(1);
  if (numero.length !== 10) return null;
  if (!["809","829","849"].includes(numero.slice(0, 3))) return null;
  return "+1" + numero;
}

function buildSystemPrompt(sesion: BotSesion): string {
  const hoy = fechaHoyRD();
  const manana = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: "America/Santo_Domingo" });

  return `Eres la recepcionista virtual del consultorio del Dr. Hairol Pérez (Oncología y Ginecología).
Tu nombre es Asistente CitasMed. Eres amable, profesional y directa. Hablas como una recepcionista médica dominicana real.
No uses emojis. Usa un tono cálido pero clínico y preciso. Máximo 4 líneas por respuesta.

HOY: ${hoy} | MAÑANA: ${manana}

SEDES:
1. Santo Domingo — Centro Médico María Dolores
2. San Pedro de Macorís — Unidad Oncológica del Este
3. Jimaní — Centro Médico Doctor Paulino

TIPOS DE CONSULTA:
- Primera vez / primera consulta
- Seguimiento / control / revisión

TU TRABAJO:
Recopila en orden natural: sede, tipo de consulta, nombre completo, teléfono, motivo médico.
Ve paso a paso. No preguntes todo de golpe.

REGLAS ESTRICTAS:
1. NO aceptes motivos que no sean médicos (ej: "hambre", "aburrimiento", "prueba").
   Si el paciente da un motivo no médico, pide amablemente el motivo real de la consulta médica.
2. Los teléfonos dominicanos tienen exactamente 10 dígitos y comienzan con 809, 829 o 849.
   Si el número no cumple esto, pide que lo corrija.
3. Nunca confirmes una cita sin tener: nombre, teléfono válido, sede, tipo y motivo médico.
4. Usa frases como: "Con gusto", "Perfecto", "Enseguida", "Me permite su...", "Le reservo..."

ESTADO ACTUAL DEL PACIENTE:
- Nombre: ${sesion.nombre ?? "pendiente"}
- Telefono: ${sesion.telefono ?? "pendiente"}
- Sede: ${sesion.sede_nombre ?? "pendiente"}
- Tipo: ${sesion.es_primera === undefined ? "pendiente" : sesion.es_primera ? "Primera vez" : "Seguimiento"}
- Motivo: ${sesion.motivo ?? "pendiente"}
- Horarios mostrados: ${sesion.slots_disponibles ?? "ninguno aun"}

CUANDO tengas sede + tipo de consulta listos: incluye exactamente [BUSCAR_SLOTS] en tu respuesta.
CUANDO pidan cancelar una cita: pide el codigo y luego incluye [CANCELAR codigo=XXXX].`;
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
  if (!res.ok) return "Disculpe, tuve un problema. Puede repetir lo que dijo?";
  const data = await res.json() as { content?: { text?: string }[] };
  return data.content?.[0]?.text?.trim() ?? "Disculpe, no pude procesar su mensaje.";
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
      system: `Extrae datos del mensaje. Responde SOLO JSON sin explicaciones ni markdown.
Campos posibles:
- nombre: string (nombre completo de persona)
- telefono: string (solo digitos, minimo 10)
- motivo: string (SOLO si es claramente medico: dolor, chequeo, sintoma, enfermedad. Si no es medico NO incluyas este campo)
- es_primera: boolean (true=primera vez, false=seguimiento/control)
- sede_ciudad: string (Santo Domingo | San Pedro | Jimani)
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

async function buscarSlots(sesion: BotSesion, fecha: string): Promise<{texto: string; slots: any[]}> {
  const result = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: sesion.sede_id,
    p_fecha: fecha,
    p_servicio_id: sesion.servicio_id,
  });
  const slots = (result.data ?? []).slice(0, 8).map((s: any, i: number) => ({
    num: i + 1, hora: toHoraRD(s.inicia_en), inicia_en: s.inicia_en,
  }));
  if (slots.length === 0) return { texto: "No hay horarios disponibles para ese dia.", slots: [] };
  const texto = slots.map((s: any) => `${s.num}. ${s.hora}`).join("\n");
  return { texto, slots };
}

async function agendarCita(sesion: BotSesion, slot: any): Promise<string | null> {
  const nombreParts = (sesion.nombre ?? "Paciente").split(" ");
  const pac = await rpc<any>("fn_get_or_create_paciente", {
    p_telefono: sesion.telefono ?? "",
    p_nombre: nombreParts[0] ?? "Paciente",
    p_apellido: nombreParts.slice(1).join(" ") || "Paciente",
    p_cedula: null, p_fecha_nacimiento: null, p_sexo: null, p_zona: null,
  });
  if (!pac.data?.[0]?.paciente_id) return null;

  const cita = await rpc<any>("fn_agendar_cita", {
    p_doctor_clinica_id: sesion.sede_id,
    p_paciente_id: pac.data[0].paciente_id,
    p_servicio_id: sesion.servicio_id,
    p_inicia_en: slot.inicia_en,
    p_motivo: sesion.motivo ?? "Consulta medica",
    p_canal: "telegram",
    p_creado_por: null,
  });

  if (!cita.data?.[0]?.exito) return null;
  return cita.data[0].codigo;
}

export async function procesarMensaje(chatId: string, texto: string): Promise<void> {
  let sesion = await getSesion(chatId);
  const historial: {role: string; content: string}[] = (sesion.historial as any) ?? [];

  const tl = texto.toLowerCase().trim();
  if (texto === "/start" || tl === "hola" || tl === "buenas" || tl === "buenos dias" || tl === "buenas tardes" || tl === "buenas noches") {
    await deleteSesion(chatId);
    sesion = {};
    historial.length = 0;
  }

  const datos = await extraerDatos(texto);

  if (datos.nombre && !sesion.nombre) sesion.nombre = datos.nombre;

  if (datos.telefono && !sesion.telefono) {
    const telValido = validarTelefonoRD(datos.telefono);
    if (telValido) sesion.telefono = telValido;
  }

  if (datos.motivo && !sesion.motivo) sesion.motivo = datos.motivo;
  if (datos.es_primera !== undefined && sesion.es_primera === undefined) sesion.es_primera = datos.es_primera;

  if (datos.sede_ciudad && !sesion.sede_id) {
    const sede = resolverSede(datos.sede_ciudad);
    if (sede) {
      sesion.sede_id = sede.dc_id;
      sesion.sede_nombre = `${sede.nombre} (${sede.ciudad})`;
    }
  }

  if (sesion.sede_id && sesion.es_primera !== undefined && !sesion.servicio_id) {
    for (const doc of DOCTORES) {
      const sede = doc.sedes.find(s => s.dc_id === sesion.sede_id);
      if (sede) {
        sesion.servicio_id = sesion.es_primera ? sede.servicios.primera_vez : sede.servicios.seguimiento;
        break;
      }
    }
  }

  if (sesion.paso === "elegir_dia" && sesion.dias_disponibles) {
    const num = parseInt(texto) - 1;
    if (!isNaN(num) && num >= 0 && num < sesion.dias_disponibles.length) {
      const fechaSel = sesion.dias_disponibles[num]!.fecha;
      const { texto: slotsTexto, slots } = await buscarSlots(sesion, fechaSel);
      sesion.fecha_sel = fechaSel;
      sesion.slots = slots;
      sesion.slots_disponibles = slotsTexto;
      sesion.paso = "elegir_hora";
      const resp = `Para el ${formatFecha(fechaSel)} tengo los siguientes horarios:\n\n${slotsTexto}\n\n¿Cual prefiere?`;
      historial.push({ role: "user", content: texto });
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20) as any;
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }
  }

  if (sesion.paso === "elegir_hora" && sesion.slots && sesion.nombre && sesion.telefono) {
    const num = parseInt(texto) - 1;
    let slotElegido = (!isNaN(num) && num >= 0 && num < sesion.slots.length)
      ? sesion.slots[num]
      : undefined;

    if (!slotElegido) {
      const textoNorm = texto.toLowerCase().replace(/\s/g, "").replace(".", ":");
      slotElegido = sesion.slots.find(s => {
        const horaNorm = s.hora.toLowerCase().replace(/\s/g, "");
        return horaNorm.includes(textoNorm) || textoNorm.includes(horaNorm.replace(":00","").replace(":30",""));
      });
    }

    if (slotElegido) {
      const codigo = await agendarCita(sesion, slotElegido);
      await deleteSesion(chatId);
      if (!codigo) {
        await enviar(chatId, "Ese horario ya no esta disponible. Escriba /start para seleccionar otro.");
        return;
      }
      await enviar(chatId,
        `Cita reservada correctamente.\n\n` +
        `Fecha: ${formatFecha(sesion.fecha_sel!)}\n` +
        `Hora: ${slotElegido.hora}\n` +
        `Paciente: ${sesion.nombre}\n` +
        `Sede: ${sesion.sede_nombre}\n` +
        `Codigo: ${codigo}\n\n` +
        `Guarde este codigo. Si necesita cancelar, envielo aqui o escriba /cancelar.`
      );
      return;
    }
  }

  historial.push({ role: "user", content: texto });
  const system = buildSystemPrompt(sesion);
  let respuesta = await llamarClaude(historial, system);

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
      respuesta += "\n\nNo hay citas disponibles en los proximos 14 dias. Puede intentar con otra sede.";
    } else {
      sesion.dias_disponibles = dias;
      sesion.paso = "elegir_dia";
      const lista = dias.map((d: any, i: number) =>
        `${i + 1}. ${formatFecha(d.fecha)} — ${d.total_slots} horarios disponibles`
      ).join("\n");
      respuesta += `\n\n${lista}\n\n¿Para que dia le reservo?`;
    }
  }

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
        p_cita_id: found.data[0].id,
        p_motivo_cancel: "cancelada_paciente",
        p_cancelado_por: null,
        p_penalizar_paciente: null,
      });
      respuesta += `\n\nCita ${codigo} cancelada correctamente.`;
      await deleteSesion(chatId);
    } else {
      respuesta += `\n\nNo se encontro una cita activa con el codigo ${codigo}.`;
    }
  }

  historial.push({ role: "assistant", content: respuesta });
  sesion.historial = historial.slice(-20) as any;
  await setSesion(chatId, sesion);
  await enviar(chatId, respuesta);
}
