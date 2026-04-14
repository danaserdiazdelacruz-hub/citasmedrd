import { getSesion, setSesion, deleteSesion } from "./sesion.js";
import { enviar } from "./telegram.js";
import { rpc, supabase } from "../lib/supabase.js";
import { ENV } from "../lib/env.js";
import { BOT_BIENVENIDA } from "./config.js";
import { BotSesion, SedeResumen, ServicioResumen, SlotResumen } from "./types.js";

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════

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

function ahoraRD(): Date {
  const now = new Date();
  const rdStr = now.toLocaleString("en-US", { timeZone: "America/Santo_Domingo" });
  return new Date(rdStr);
}

function validarTelefonoRD(tel: string): string | null {
  const digits = tel.replace(/\D/g, "");
  let numero = digits;
  if (numero.length === 11 && numero.startsWith("1")) numero = numero.slice(1);
  if (numero.length !== 10) return null;
  if (!["809","829","849"].includes(numero.slice(0, 3))) return null;
  return "+1" + numero;
}

// ══════════════════════════════════════════════════════════
// DETECCIÓN DE INTENCIÓN (sin depender de Claude)
// ══════════════════════════════════════════════════════════

function esIntencionCancelar(texto: string): boolean {
  const t = texto.toLowerCase();
  const palabrasCancelar = [
    "cancelar", "cancela", "anular", "anula", "eliminar", 
    "quitar", "borrar", "sacar", "puedo cancelar", "quiero cancelar",
    "necesito cancelar", "deseo cancelar", "cancelacion", "cancelación",
    "no puedo ir", "no ire", "no iré", "no asistire", "no asistiré"
  ];
  return palabrasCancelar.some(p => t.includes(p));
}

function extraerCodigoCita(texto: string): string | null {
  // Busca CITA-XXXX o solo XXXX (4-8 caracteres alfanuméricos)
  const match = texto.match(/(CITA-)?([A-Z0-9]{4,8})/i);
  if (match) return (match[1] || "CITA-") + match[2]!.toUpperCase();
  return null;
}

// ══════════════════════════════════════════════════════════
// SUPABASE
// ══════════════════════════════════════════════════════════

async function buscarDoctor(texto: string): Promise<any | null> {
  const clean = texto.trim();
  if (!clean || clean.length < 2) return null;

  if (/^\d+$/.test(clean)) {
    const res = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
      extension: `eq.${clean}`,
      activo: "eq.true",
      select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
      limit: "1",
    });
    if (Array.isArray(res.data) && res.data[0]) return res.data[0];
  }

  const res = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
    activo: "eq.true",
    or: `(nombre.ilike.*${clean}*,apellido.ilike.*${clean}*)`,
    select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
    limit: "5",
  });

  if (!res.data || !Array.isArray(res.data) || res.data.length === 0) return null;
  if (res.data.length === 1) return res.data[0];
  return { multiples: res.data };
}

async function buscarDoctorAgresivo(texto: string): Promise<any | null> {
  const limpio = texto.replace(/[^a-záéíóúñü\s\d]/gi, "").trim();
  let resultado = await buscarDoctor(limpio);
  if (resultado) return resultado;

  const palabras = limpio.split(/\s+/).filter(p => p.length >= 3);
  for (const palabra of palabras) {
    const skip = ["que","quien","quién","cual","cuál","como","cómo","con","por","para",
      "los","las","del","una","uno","ese","esa","doctor","doctora","dra","quiero",
      "busca","buscar","deseo","necesito","donde","esta","nombre",
      "extension","consulta","cita","agendar","ver","saber","info",
      "favor","puede","podria","hola","buenas","buenos","dias",
      "tienes","acceso","base","datos","cancelar","puedo","tengo","una"];
    if (skip.includes(palabra.toLowerCase())) continue;
    resultado = await buscarDoctor(palabra);
    if (resultado) return resultado;
  }
  return null;
}

async function buscarSedes(doctorId: string): Promise<SedeResumen[]> {
  const res = await supabase<SedeResumen[]>("GET", "/rest/v1/doctor_clinica", null, {
    doctor_id: `eq.${doctorId}`,
    activo: "eq.true",
    select: "id,clinicas(nombre,ciudad,direccion,telefono)",
  });
  return res.data ?? [];
}

async function buscarServicios(dcId: string): Promise<ServicioResumen[]> {
  const res = await supabase<ServicioResumen[]>("GET", "/rest/v1/servicios", null, {
    doctor_clinica_id: `eq.${dcId}`,
    activo: "eq.true",
    invisible_para_pacientes: "eq.false",
    select: "id,nombre,duracion_min,tipo",
  });
  return res.data ?? [];
}

async function buscarSlots(dcId: string, srvId: string, fecha: string): Promise<{texto: string; slots: SlotResumen[]}> {
  const result = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: dcId,
    p_fecha: fecha,
    p_servicio_id: srvId,
  });

  const hoy = fechaHoyRD();
  const ahora = ahoraRD();
  const rawSlots = result.data ?? [];
  
  const filtrados = rawSlots.filter((s: any) => {
    if (fecha !== hoy) return true;
    const slotTime = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
    return slotTime > ahora;
  });

  const slots: SlotResumen[] = filtrados.slice(0, 8).map((s: any, i: number) => ({
    num: i + 1,
    hora: toHoraRD(s.inicia_en),
    inicia_en: s.inicia_en,
  }));

  if (slots.length === 0) return { texto: "No hay horarios disponibles.", slots: [] };
  return { texto: slots.map(s => `${s.num}. ${s.hora}`).join("\n"), slots };
}

async function agendarCita(sesion: BotSesion, slot: SlotResumen): Promise<string | null> {
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
    p_motivo: sesion.motivo ?? "Consulta",
    p_canal: "telegram",
    p_creado_por: null,
  });

  return cita.data?.[0]?.exito ? cita.data[0].codigo : null;
}

async function cancelarCita(codigo: string): Promise<{exito: boolean; mensaje: string}> {
  let codigoNorm = codigo.toUpperCase();
  if (!codigoNorm.startsWith("CITA-")) codigoNorm = "CITA-" + codigoNorm;

  const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    codigo: `eq.${codigoNorm}`, select: "id,estado,paciente_id", limit: "1",
  });

  if (!found.data?.[0]) {
    return { exito: false, mensaje: `No encontré cita con código ${codigoNorm}.` };
  }

  if (!["pendiente","confirmada"].includes(found.data[0].estado)) {
    return { exito: false, mensaje: `La cita ya está ${found.data[0].estado}.` };
  }

  await rpc<any>("fn_cancelar_cita", {
    p_cita_id: found.data[0].id,
    p_motivo_cancel: "cancelada_paciente",
    p_cancelado_por: null,
    p_penalizar_paciente: null,
  });

  return { exito: true, mensaje: `✅ Cita ${codigoNorm} cancelada correctamente.` };
}

// ══════════════════════════════════════════════════════════
// CLAUDE (solo para extraer datos, no para lógica principal)
// ══════════════════════════════════════════════════════════

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
      max_tokens: 150,
      system: `Extrae datos de este mensaje de un paciente. Responde SOLO JSON:

{
  "nombre": "nombre del paciente si lo hay",
  "telefono": "solo digitos",
  "motivo": "motivo medico",
  "es_primera": true/false,
  "provincia": "ciudad preferida"
}

Si no hay un dato, no lo incluyas. Si no hay nada, devuelve {}.`,
      messages: [{ role: "user", content: texto }],
    }),
  });
  try {
    const data = await res.json() as { content?: { text?: string }[] };
    const text = data.content?.[0]?.text?.trim() ?? "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch { return {}; }
}

// ══════════════════════════════════════════════════════════
// FORMATOS
// ══════════════════════════════════════════════════════════

function formatDoctorEncontrado(doc: any, sedes: SedeResumen[]): string {
  const esp = (doc.especialidades ?? [])
    .map((e: any) => e.especialidades?.nombre)
    .filter(Boolean)
    .join(", ");

  let msg = `He identificado al Dr. ${doc.nombre} ${doc.apellido}`;
  if (esp) msg += ` — ${esp}`;
  if (doc.extension) msg += ` (ext. ${doc.extension})`;
  msg += ".\n";

  if (sedes.length === 1) {
    const s = sedes[0]!;
    msg += `\n📍 ${s.clinicas?.nombre}, ${s.clinicas?.ciudad}`;
    if (s.clinicas?.telefono) msg += `\n📞 ${s.clinicas.telefono}`;
    msg += `\n\n¿Primera consulta o seguimiento?`;
  } else {
    msg += `\n📍 Sedes disponibles:\n`;
    msg += sedes.map((s, i) => `${i + 1}. ${s.clinicas?.nombre} — ${s.clinicas?.ciudad}`).join("\n");
    msg += `\n\n¿En cuál sede? (número o nombre)`;
  }
  return msg;
}

// ══════════════════════════════════════════════════════════
// FLUJO PRINCIPAL
// ══════════════════════════════════════════════════════════

export async function procesarMensaje(chatId: string, texto: string): Promise<void> {
  let sesion = await getSesion(chatId);
  const tl = texto.toLowerCase().trim();

  console.log(`[MENSAJE] "${texto}" | paso: ${sesion.paso} | codigo_guardado: ${sesion.ultima_cita_codigo}`);

  // ═══════════════════════════════════════════════════════
  // 1. DETECTAR CANCELACIÓN (alto prioridad)
  // ═══════════════════════════════════════════════════════
  
  const quiereCancelar = esIntencionCancelar(texto);
  const codigoEnTexto = extraerCodigoCita(texto);

  if (quiereCancelar || codigoEnTexto || sesion.paso === "cancelar") {
    
    // Si escribió un código directamente
    if (codigoEnTexto && !quiereCancelar) {
      const r = await cancelarCita(codigoEnTexto);
      await enviar(chatId, r.mensaje);
      sesion.paso = "inicio";
      await setSesion(chatId, sesion);
      return;
    }

    // Si quiere cancelar y tenemos código guardado
    if (quiereCancelar && sesion.ultima_cita_codigo && !codigoEnTexto) {
      await enviar(chatId, `¿Desea cancelar su cita ${sesion.ultima_cita_codigo}? Responda: SI o indique otro código.`);
      sesion.paso = "confirmar_cancelar";
      await setSesion(chatId, sesion);
      return;
    }

    // Si está confirmando cancelación
    if (sesion.paso === "confirmar_cancelar") {
      if (["si","sí","yes","ok"].includes(tl)) {
        const r = await cancelarCita(sesion.ultima_cita_codigo!);
        await enviar(chatId, r.mensaje);
        sesion.ultima_cita_codigo = undefined;
      } else {
        // Asumir que escribió otro código
        const codigo = extraerCodigoCita(texto) || texto;
        const r = await cancelarCita(codigo);
        await enviar(chatId, r.mensaje);
      }
      sesion.paso = "inicio";
      await setSesion(chatId, sesion);
      return;
    }

    // Si quiere cancelar pero no tenemos código
    if (quiereCancelar && !sesion.ultima_cita_codigo) {
      await enviar(chatId, "Indique el código de la cita a cancelar (ej: CITA-A54CD8 o solo A54CD8):");
      sesion.paso = "cancelar";
      await setSesion(chatId, sesion);
      return;
    }

    // Si está en paso cancelar y escribe código
    if (sesion.paso === "cancelar") {
      const codigo = extraerCodigoCita(texto) || texto;
      const r = await cancelarCita(codigo);
      await enviar(chatId, r.mensaje);
      sesion.paso = "inicio";
      await setSesion(chatId, sesion);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════
  // 2. SALUDO / RESET
  // ═══════════════════════════════════════════════════════
  
  if (texto === "/start" || ["hola","buenas","buenos dias","buenas tardes"].includes(tl)) {
    // NO borrar ultima_cita_codigo para permitir cancelar después de saludar
    const codigoGuardado = sesion.ultima_cita_codigo;
    sesion = { paso: "inicio", ultima_cita_codigo: codigoGuardado };
    await setSesion(chatId, sesion);
    await enviar(chatId, BOT_BIENVENIDA);
    return;
  }

  // ═══════════════════════════════════════════════════════
  // 3. EXTRAER DATOS CON CLAUDE
  // ═══════════════════════════════════════════════════════
  
  const datos = await extraerDatos(texto);
  console.log("[EXTRAIDO]", datos);

  if (datos.nombre && !sesion.nombre) sesion.nombre = datos.nombre;
  if (datos.motivo && !sesion.motivo) sesion.motivo = datos.motivo;
  if (datos.telefono && !sesion.telefono) {
    const t = validarTelefonoRD(datos.telefono);
    if (t) sesion.telefono = t;
  }
  if (datos.es_primera !== undefined && sesion.es_primera === undefined) {
    sesion.es_primera = datos.es_primera;
  }

  // Detección directa de tipo consulta
  if (sesion.es_primera === undefined) {
    if (["primera","nueva","nuevo"].some(p => tl.includes(p))) sesion.es_primera = true;
    else if (["seguimiento","control","revision"].some(p => tl.includes(p))) sesion.es_primera = false;
  }

  // ═══════════════════════════════════════════════════════
  // 4. BÚSQUEDA DE DOCTOR
  // ═══════════════════════════════════════════════════════
  
  if (!sesion.doctor_id && !sesion.doctores_multiples) {
    const resultado = await buscarDoctorAgresivo(texto);

    if (resultado?.multiples) {
      sesion.doctores_multiples = resultado.multiples;
      await setSesion(chatId, sesion);
      const lista = resultado.multiples.map((d: any, i: number) => 
        `${i + 1}. Dr. ${d.nombre} ${d.apellido}${d.extension ? ` (ext. ${d.extension})` : ""}`
      ).join("\n");
      await enviar(chatId, `Encontré varios doctores:\n\n${lista}\n\nIndique el número:`);
      return;
    }

    if (resultado && !resultado.multiples) {
      sesion.doctor_id = resultado.id;
      sesion.doctor_nombre = `Dr. ${resultado.nombre} ${resultado.apellido}`;
      if (resultado.extension) sesion.doctor_extension = resultado.extension;

      // Limpiar nombre si es el doctor
      if (sesion.nombre?.toLowerCase().includes(resultado.nombre.toLowerCase())) {
        delete sesion.nombre;
      }

      const sedes = await buscarSedes(resultado.id);
      sesion.sedes_disponibles = sedes;

      if (sedes.length === 1) {
        const u = sedes[0]!;
        sesion.sede_id = u.id;
        sesion.sede_nombre = `${u.clinicas?.nombre} (${u.clinicas?.ciudad})`;
        sesion.servicios_disponibles = await buscarServicios(u.id);
      }

      await setSesion(chatId, sesion);
      await enviar(chatId, formatDoctorEncontrado(resultado, sedes));
      return;
    }

    await enviar(chatId, "No encontré doctor con ese nombre. Intente de nuevo:");
    return;
  }

  // Selección doctor múltiple
  if (!sesion.doctor_id && sesion.doctores_multiples) {
    const num = parseInt(texto) - 1;
    if (!isNaN(num) && num >= 0 && num < sesion.doctores_multiples.length) {
      const doc = sesion.doctores_multiples[num]!;
      sesion.doctor_id = doc.id;
      sesion.doctor_nombre = `Dr. ${doc.nombre} ${doc.apellido}`;
      const sedes = await buscarSedes(doc.id);
      sesion.sedes_disponibles = sedes;
      delete sesion.doctores_multiples;
      
      if (sedes.length === 1) {
        const u = sedes[0]!;
        sesion.sede_id = u.id;
        sesion.sede_nombre = `${u.clinicas?.nombre} (${u.clinicas?.ciudad})`;
        sesion.servicios_disponibles = await buscarServicios(u.id);
      }
      await setSesion(chatId, sesion);
      await enviar(chatId, formatDoctorEncontrado(doc, sedes));
      return;
    }
    await enviar(chatId, "Número inválido. Intente de nuevo:");
    return;
  }

  // ═══════════════════════════════════════════════════════
  // 5. SELECCIÓN DE SEDE
  // ═══════════════════════════════════════════════════════
  
  if (sesion.doctor_id && !sesion.sede_id && sesion.sedes_disponibles) {
    const sedes = sesion.sedes_disponibles;
    const num = parseInt(texto) - 1;
    let elegida: SedeResumen | undefined;

    if (!isNaN(num) && num >= 0 && num < sedes.length) {
      elegida = sedes[num];
    } else {
      elegida = sedes.find(s => {
        const nom = s.clinicas?.nombre?.toLowerCase() ?? "";
        const ciu = s.clinicas?.ciudad?.toLowerCase() ?? "";
        return nom.includes(tl) || tl.includes(nom) || ciu.includes(tl);
      });
    }

    if (elegida) {
      sesion.sede_id = elegida.id;
      sesion.sede_nombre = `${elegida.clinicas?.nombre} (${elegida.clinicas?.ciudad})`;
      sesion.servicios_disponibles = await buscarServicios(elegida.id);
      
      let resp = `✅ ${sesion.sede_nombre}`;
      if (elegida.clinicas?.telefono) resp += `\n📞 ${elegida.clinicas.telefono}`;
      resp += `\n\n¿Primera consulta o seguimiento?`;
      
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }
    await enviar(chatId, "No entendí. Indique número o nombre de la sede:");
    return;
  }

  // ═══════════════════════════════════════════════════════
  // 6. TIPO CONSULTA → SERVICIO
  // ═══════════════════════════════════════════════════════
  
  if (sesion.sede_id && sesion.es_primera === undefined) {
    if (["primera","nueva"].some(p => tl.includes(p))) {
      sesion.es_primera = true;
    } else if (["seguimiento","control"].some(p => tl.includes(p))) {
      sesion.es_primera = false;
    } else {
      await enviar(chatId, "¿Es primera consulta o seguimiento?");
      return;
    }
  }

  if (sesion.sede_id && sesion.es_primera !== undefined && !sesion.servicio_id) {
    const servicios = sesion.servicios_disponibles ?? [];
    const srv = sesion.es_primera
      ? servicios.find(s => s.tipo === "primera_vez") ?? servicios[0]
      : servicios.find(s => s.tipo === "normal") ?? servicios[0];
    if (srv) sesion.servicio_id = srv.id;
  }

  // ═══════════════════════════════════════════════════════
  // 7. DATOS DEL PACIENTE (nombre → teléfono → motivo)
  // ═══════════════════════════════════════════════════════
  
  if (sesion.servicio_id && !sesion.nombre) {
    await enviar(chatId, "Me permite su nombre completo:");
    return;
  }

  if (sesion.nombre && !sesion.telefono) {
    const t = validarTelefonoRD(texto);
    if (t) {
      sesion.telefono = t;
    } else {
      await enviar(chatId, "Número de teléfono (10 dígitos, 809/829/849):");
      return;
    }
  }

  if (sesion.telefono && !sesion.motivo) {
    if (datos.motivo) {
      sesion.motivo = datos.motivo;
    } else {
      await enviar(chatId, "¿Motivo de la consulta?");
      return;
    }
  }

  // ═══════════════════════════════════════════════════════
  // 8. MOSTRAR DÍAS DISPONIBLES
  // ═══════════════════════════════════════════════════════
  
  if (sesion.motivo && sesion.paso !== "elegir_dia" && sesion.paso !== "elegir_hora") {
    const result = await rpc<any>("fn_dias_disponibles", {
      p_doctor_clinica_id: sesion.sede_id,
      p_servicio_id: sesion.servicio_id,
      p_dias_adelante: 14,
      p_max_resultados: 5,
    });

    const dias = (result.data ?? []).filter((d: any) => d.fecha >= fechaHoyRD());

    if (dias.length === 0) {
      await enviar(chatId, "No hay citas disponibles. Intente otra sede.");
      return;
    }

    sesion.dias_disponibles = dias;
    sesion.paso = "elegir_dia";
    await setSesion(chatId, sesion);

    const lista = dias.map((d: any, i: number) => 
      `${i + 1}. ${formatFecha(d.fecha)} (${d.total_slots} horarios)`
    ).join("\n");
    
    await enviar(chatId, `📅 Días disponibles:\n\n${lista}\n\n¿Qué día? (1-${dias.length})`);
    return;
  }

  // ═══════════════════════════════════════════════════════
  // 9. SELECCIÓN DE DÍA
  // ═══════════════════════════════════════════════════════
  
  if (sesion.paso === "elegir_dia" && sesion.dias_disponibles) {
    const num = parseInt(texto) - 1;
    if (isNaN(num) || num < 0 || num >= sesion.dias_disponibles.length) {
      await enviar(chatId, `Elija 1-${sesion.dias_disponibles.length}:`);
      return;
    }

    const fechaSel = sesion.dias_disponibles[num]!.fecha;
    const { texto: slotsTexto, slots } = await buscarSlots(sesion.sede_id!, sesion.servicio_id!, fechaSel);

    if (slots.length === 0) {
      await enviar(chatId, "No hay horarios. Elija otro día:");
      return;
    }

    sesion.fecha_sel = fechaSel;
    sesion.slots = slots;
    sesion.paso = "elegir_hora";
    await setSesion(chatId, sesion);

    await enviar(chatId, `⏰ Horarios ${formatFecha(fechaSel)}:\n\n${slotsTexto}\n\n¿Cuál hora?`);
    return;
  }

  // ═══════════════════════════════════════════════════════
  // 10. SELECCIÓN DE HORA Y AGENDAR
  // ═══════════════════════════════════════════════════════
  
  if (sesion.paso === "elegir_hora" && sesion.slots) {
    const num = parseInt(texto) - 1;
    let slot = sesion.slots[num];

    if (!slot) {
      // Buscar por texto de hora
      const txt = texto.toLowerCase().replace(/\s/g, "").replace(".", ":");
      slot = sesion.slots.find(s => s.hora.toLowerCase().replace(/\s/g, "").includes(txt));
    }

    if (!slot) {
      await enviar(chatId, "Horario no válido. Elija de la lista:");
      return;
    }

    // Verificar que no haya pasado
    if (sesion.fecha_sel === fechaHoyRD()) {
      const slotTime = new Date(new Date(slot.inicia_en).toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
      if (slotTime <= ahoraRD()) {
        await enviar(chatId, "Ese horario ya pasó. Elija otro:");
        return;
      }
    }

    const codigo = await agendarCita(sesion, slot);
    if (!codigo) {
      await enviar(chatId, "Horario ya no disponible. Elija otro:");
      return;
    }

    // Guardar código y resetear flujo pero MANTENER código para cancelación
    sesion = {
      paso: "inicio",
      ultima_cita_codigo: codigo,
      doctor_id: sesion.doctor_id,
      doctor_nombre: sesion.doctor_nombre,
    };
    await setSesion(chatId, sesion);

    await enviar(chatId,
      `✅ *Cita reservada*\n\n` +
      `👨‍⚕️ ${sesion.doctor_nombre}\n` +
      `📅 ${formatFecha(sesion.fecha_sel!)} a las ${slot.hora}\n` +
      `🏥 ${sesion.sede_nombre}\n` +
      `👤 ${sesion.nombre}\n` +
      `🔑 *${codigo}*\n\n` +
      `Para cancelar escriba: cancelar o el código`
    );
    return;
  }

  // ═══════════════════════════════════════════════════════
  // DEFAULT
  // ═══════════════════════════════════════════════════════
  
  await enviar(chatId, "No entendí. Escriba /start para comenzar.");
}
