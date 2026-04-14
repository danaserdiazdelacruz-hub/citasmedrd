import { getSesion, setSesion, deleteSesion } from "./sesion.js";
import { enviar } from "./telegram.js";
import { rpc, supabase } from "../lib/supabase.js";
import { ENV } from "../lib/env.js";
import { BOT_BIENVENIDA } from "./config.js";
import { BotSesion, SedeResumen, ServicioResumen, SlotResumen } from "./types.js";
import { detectarIntencionCancelar } from "./claude-ai.js";

// ──────────────────────────────────────────────────────────
// Helpers de formato
// ──────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────
// Consultas a Supabase
// ──────────────────────────────────────────────────────────

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
      "busca","buscar","deseo","necesito","tiene","donde","esta","nombre",
      "extension","consulta","cita","agendar","ver","saber","información","info",
      "favor","puede","podria","quiere","hola","buenas","buenos","dias",
      "tienes","acceso","base","datos","cancelar"];
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

  if (slots.length === 0) return { texto: "No hay horarios disponibles para ese día.", slots: [] };
  const texto = slots.map(s => `${s.num}. ${s.hora}`).join("\n");
  return { texto, slots };
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
    p_motivo: sesion.motivo ?? "Consulta medica",
    p_canal: "telegram",
    p_creado_por: null,
  });

  if (!cita.data?.[0]?.exito) return null;
  return cita.data[0].codigo;
}

async function cancelarCitaPorCodigo(codigo: string): Promise<{exito: boolean; mensaje: string}> {
  let codigoNormalizado = codigo.toUpperCase().trim();
  if (!codigoNormalizado.startsWith("CITA-")) codigoNormalizado = "CITA-" + codigoNormalizado;

  const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    codigo: `eq.${codigoNormalizado}`, select: "id,estado", limit: "1",
  });

  if (!found.data?.[0]) {
    return { exito: false, mensaje: `No se encontró cita con código ${codigoNormalizado}.` };
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

  return { exito: true, mensaje: `Cita ${codigoNormalizado} cancelada.` };
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
      system: `Extrae datos del mensaje. Responde SOLO JSON sin markdown.

Campos:
- nombre: nombre completo del PACIENTE (no del doctor)
- telefono: solo dígitos, mínimo 10
- motivo: motivo médico (dolor, síntoma, etc.)
- es_primera: true/false
- provincia: ciudad/sede preferida

NO incluyas doctor_busqueda. Si no hay datos, devuelve {}`,
      messages: [{ role: "user", content: texto }],
    }),
  });
  try {
    const data = await res.json() as { content?: { text?: string }[] };
    const text = data.content?.[0]?.text?.trim() ?? "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch { return {}; }
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
  if (!res.ok) return "Disculpe, tuve un problema técnico.";
  const data = await res.json() as { content?: { text?: string }[] };
  return data.content?.[0]?.text?.trim() ?? "No pude procesar su mensaje.";
}

function formatDoctorEncontrado(doc: any, sedes: SedeResumen[]): string {
  const especialidades = (doc.especialidades ?? [])
    .map((e: any) => e.especialidades?.nombre)
    .filter(Boolean)
    .join(", ");

  let msg = `He identificado al Dr. ${doc.nombre} ${doc.apellido}`;
  if (especialidades) msg += ` — ${especialidades}`;
  if (doc.extension) msg += ` (ext. ${doc.extension})`;
  msg += ".\n";

  if (sedes.length === 1) {
    const s = sedes[0]!;
    msg += `\nAtiende en: ${s.clinicas?.nombre}, ${s.clinicas?.ciudad}.`;
    if (s.clinicas?.direccion) msg += `\nDirección: ${s.clinicas.direccion}`;
    if (s.clinicas?.telefono) msg += `\nTeléfono: ${s.clinicas.telefono}`;
    msg += `\n\n¿Es esta su primera consulta con el doctor, o viene por seguimiento?`;
  } else if (sedes.length > 1) {
    msg += `\nAtiende en:\n`;
    msg += sedes.map((s, i) => {
      let linea = `${i + 1}. ${s.clinicas?.nombre} — ${s.clinicas?.ciudad}`;
      if (s.clinicas?.telefono) linea += ` — Tel: ${s.clinicas.telefono}`;
      return linea;
    }).join("\n");
    msg += `\n\n¿En cuál sede desea ser atendido?`;
  }
  return msg;
}

// ══════════════════════════════════════════════════════════
// FLUJO PRINCIPAL
// ══════════════════════════════════════════════════════════

export async function procesarMensaje(chatId: string, texto: string): Promise<void> {
  let sesion = await getSesion(chatId);
  const historial: {role: string; content: string}[] = sesion.historial ?? [];
  const tl = texto.toLowerCase().trim();

  // ── SALUDO / RESET ──
  const esSaludo = texto === "/start" || ["hola","buenas","buenos dias","buenas tardes","buenas noches","inicio"].includes(tl);
  if (esSaludo) {
    await deleteSesion(chatId);
    sesion = { paso: "inicio" };
    historial.length = 0;
    await enviar(chatId, BOT_BIENVENIDA);
    return;
  }

  // ── CANCELAR ──
  const esCancelacion = await detectarIntencionCancelar(texto);
  const pareceCodigo = /^CITA-[A-Z0-9]+$/i.test(texto) || /^[A-Z0-9]{4,}$/i.test(texto);
  const mencionaCancelar = tl.includes("cancelar") || tl.includes("anular");

  if (esCancelacion || mencionaCancelar || sesion.paso === "esperando_codigo_cancelar") {
    if (sesion.ultima_cita_codigo && !pareceCodigo) {
      const r = await cancelarCitaPorCodigo(sesion.ultima_cita_codigo);
      await enviar(chatId, r.mensaje);
      if (r.exito) sesion.ultima_cita_codigo = undefined;
      await setSesion(chatId, sesion);
      return;
    }
    if (pareceCodigo) {
      const codigo = texto.trim();
      const r = await cancelarCitaPorCodigo(codigo);
      await enviar(chatId, r.mensaje);
      sesion.paso = "inicio";
      await setSesion(chatId, sesion);
      return;
    }
    await enviar(chatId, "Indique el código de la cita a cancelar (ej: CITA-8855FC):");
    sesion.paso = "esperando_codigo_cancelar";
    await setSesion(chatId, sesion);
    return;
  }

  // ── EXTRAER DATOS CON CLAUDE ──
  const datos = await extraerDatos(texto);
  console.log("[Datos extraídos]", JSON.stringify(datos));

  // Guardar datos extraídos
  if (datos.nombre && !sesion.nombre) sesion.nombre = datos.nombre;
  if (datos.motivo && !sesion.motivo) sesion.motivo = datos.motivo;
  if (datos.es_primera !== undefined && sesion.es_primera === undefined) sesion.es_primera = datos.es_primera;
  if (datos.telefono && !sesion.telefono) {
    const t = validarTelefonoRD(datos.telefono);
    if (t) sesion.telefono = t;
  }

  // Detección directa de tipo consulta
  if (sesion.es_primera === undefined) {
    if (["primera","primera vez","nuevo","nueva"].some(p => tl.includes(p))) sesion.es_primera = true;
    else if (["seguimiento","control","revision","chequeo"].some(p => tl.includes(p))) sesion.es_primera = false;
  }

  // ── BÚSQUEDA DE DOCTOR ──
  if (!sesion.doctor_id && !sesion.doctores_multiples) {
    const resultado = await buscarDoctorAgresivo(texto);

    if (resultado?.multiples) {
      const lista = resultado.multiples.map((d: any, i: number) =>
        `${i + 1}. Dr. ${d.nombre} ${d.apellido}${d.extension ? ` (ext. ${d.extension})` : ""}`
      ).join("\n");
      sesion.doctores_multiples = resultado.multiples;
      await setSesion(chatId, sesion);
      await enviar(chatId, `Encontré varios doctores:\n\n${lista}\n\nIndique el número o extensión:`);
      return;
    }

    if (resultado && !resultado.multiples) {
      sesion.doctor_id = resultado.id;
      sesion.doctor_nombre = `Dr. ${resultado.nombre} ${resultado.apellido}`;
      if (resultado.extension) sesion.doctor_extension = resultado.extension;

      // Limpiar nombre si coincide con doctor
      if (sesion.nombre?.toLowerCase() === `${resultado.nombre} ${resultado.apellido}`.toLowerCase()) {
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

    await enviar(chatId, "No encontré doctor con ese nombre/extensión. Verifique e intente de nuevo.");
    return;
  }

  // ── SELECCIÓN DOCTOR MÚLTIPLE ──
  if (!sesion.doctor_id && sesion.doctores_multiples) {
    const num = parseInt(texto) - 1;
    if (!isNaN(num) && num >= 0 && num < sesion.doctores_multiples.length) {
      const doc = sesion.doctores_multiples[num]!;
      sesion.doctor_id = doc.id;
      sesion.doctor_nombre = `Dr. ${doc.nombre} ${doc.apellido}`;
      if (doc.extension) sesion.doctor_extension = doc.extension;
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
    await enviar(chatId, "Número inválido. Intente de nuevo.");
    return;
  }

  // ── SELECCIÓN DE SEDE ──
  if (sesion.doctor_id && !sesion.sede_id && sesion.sedes_disponibles) {
    const sedes = sesion.sedes_disponibles;
    const num = parseInt(texto) - 1;
    let elegida: SedeResumen | undefined;

    if (!isNaN(num) && num >= 0 && num < sedes.length) {
      elegida = sedes[num];
    } else {
      const txt = tl;
      elegida = sedes.find(s => {
        const nom = s.clinicas?.nombre?.toLowerCase() ?? "";
        const ciu = s.clinicas?.ciudad?.toLowerCase() ?? "";
        return nom.includes(txt) || txt.includes(nom) || ciu.includes(txt) || txt.includes(ciu);
      });
    }

    if (elegida) {
      sesion.sede_id = elegida.id;
      sesion.sede_nombre = `${elegida.clinicas?.nombre} (${elegida.clinicas?.ciudad})`;
      sesion.servicios_disponibles = await buscarServicios(elegida.id);
      
      let resp = `Perfecto. ${sesion.sede_nombre}.`;
      if (elegida.clinicas?.direccion) resp += `\nDirección: ${elegida.clinicas.direccion}`;
      if (elegida.clinicas?.telefono) resp += `\nTeléfono: ${elegida.clinicas.telefono}`;
      resp += `\n\n¿Es primera consulta o seguimiento?`;
      
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }
    await enviar(chatId, "No entendí la sede. Indique el número o nombre:");
    return;
  }

  // ── SELECCIÓN TIPO CONSULTA ──
  if (sesion.sede_id && sesion.es_primera === undefined) {
    if (["primera","nueva","nuevo"].some(p => tl.includes(p))) {
      sesion.es_primera = true;
    } else if (["seguimiento","control","revision"].some(p => tl.includes(p))) {
      sesion.es_primera = false;
    } else {
      await enviar(chatId, "¿Es primera consulta o seguimiento?");
      return;
    }
  }

  // ── ASIGNAR SERVICIO ──
  if (sesion.sede_id && sesion.es_primera !== undefined && !sesion.servicio_id) {
    const servicios = sesion.servicios_disponibles ?? [];
    const srv = sesion.es_primera
      ? servicios.find(s => s.tipo === "primera_vez") ?? servicios[0]
      : servicios.find(s => s.tipo === "normal") ?? servicios[0];
    if (srv) sesion.servicio_id = srv.id;
  }

  // ── PEDIR NOMBRE ──
  if (sesion.servicio_id && !sesion.nombre) {
    await enviar(chatId, "Me permite su nombre completo:");
    return;
  }

  // ── PEDIR TELÉFONO ──
  if (sesion.nombre && !sesion.telefono) {
    // Validar si el texto actual es teléfono
    const t = validarTelefonoRD(texto);
    if (t) {
      sesion.telefono = t;
    } else {
      await enviar(chatId, "Me permite su número de teléfono (10 dígitos, 809/829/849):");
      return;
    }
  }

  // ── PEDIR MOTIVO ──
  if (sesion.telefono && !sesion.motivo) {
    if (datos.motivo) {
      sesion.motivo = datos.motivo;
    } else {
      await enviar(chatId, "¿Cuál es el motivo de su consulta?");
      return;
    }
  }

  // ── MOSTRAR DÍAS DISPONIBLES ──
  if (sesion.motivo && sesion.paso !== "elegir_dia" && sesion.paso !== "elegir_hora") {
    console.log("[BUSCANDO DÍAS] sede=", sesion.sede_id, "servicio=", sesion.servicio_id);
    
    const result = await rpc<any>("fn_dias_disponibles", {
      p_doctor_clinica_id: sesion.sede_id,
      p_servicio_id: sesion.servicio_id,
      p_dias_adelante: 14,
      p_max_resultados: 5,
    });

    let dias = (result.data ?? []).filter((d: any) => d.fecha >= fechaHoyRD());

    if (dias.length === 0) {
      await enviar(chatId, "No hay citas disponibles en los próximos 14 días. Intente otra sede.");
      return;
    }

    sesion.dias_disponibles = dias;
    sesion.paso = "elegir_dia";
    await setSesion(chatId, sesion);

    const lista = dias.map((d: any, i: number) => 
      `${i + 1}. ${formatFecha(d.fecha)} — ${d.total_slots} horarios`
    ).join("\n");
    
    await enviar(chatId, `Días disponibles:\n\n${lista}\n\n¿Para qué día? (1-${dias.length})`);
    return;
  }

  // ── SELECCIÓN DE DÍA ──
  if (sesion.paso === "elegir_dia" && sesion.dias_disponibles) {
    const num = parseInt(texto) - 1;
    if (isNaN(num) || num < 0 || num >= sesion.dias_disponibles.length) {
      await enviar(chatId, `Seleccione un número del 1 al ${sesion.dias_disponibles.length}:`);
      return;
    }

    const fechaSel = sesion.dias_disponibles[num]!.fecha;
    const { texto: slotsTexto, slots } = await buscarSlots(sesion.sede_id!, sesion.servicio_id!, fechaSel);

    if (slots.length === 0) {
      await enviar(chatId, "Ya no hay horarios para ese día. Elija otro:");
      return;
    }

    sesion.fecha_sel = fechaSel;
    sesion.slots = slots;
    sesion.slots_disponibles = slotsTexto;
    sesion.paso = "elegir_hora";
    await setSesion(chatId, sesion);

    await enviar(chatId, `Horarios para ${formatFecha(fechaSel)}:\n\n${slotsTexto}\n\n¿Cuál prefiere?`);
    return;
  }

  // ── SELECCIÓN DE HORA ──
  if (sesion.paso === "elegir_hora" && sesion.slots) {
    const num = parseInt(texto) - 1;
    let slot = sesion.slots[num];

    // Si no es número, buscar por texto de hora
    if (!slot) {
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
      await enviar(chatId, "Ese horario ya no está disponible. Intente con otro:");
      return;
    }

    // Guardar sesión con código, NO borrar
    sesion.paso = "inicio";
    sesion.ultima_cita_codigo = codigo;
    sesion.dias_disponibles = undefined;
    sesion.slots = undefined;
    await setSesion(chatId, sesion);

    await enviar(chatId,
      `✅ Cita reservada\n\n` +
      `Doctor: ${sesion.doctor_nombre}\n` +
      `Fecha: ${formatFecha(sesion.fecha_sel!)}\n` +
      `Hora: ${slot.hora}\n` +
      `Paciente: ${sesion.nombre}\n` +
      `Sede: ${sesion.sede_nombre}\n` +
      `Código: ${codigo}\n\n` +
      `Para cancelar escriba: cancelar`
    );
    return;
  }

  // ── RESPUESTA POR DEFECTO ──
  await enviar(chatId, "No entendí. Escriba /start para comenzar de nuevo.");
}
