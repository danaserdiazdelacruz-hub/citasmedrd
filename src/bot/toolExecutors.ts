// src/bot/toolExecutors.ts — Ejecutores de herramientas (endurecido para producción)
import { supabase, rpc } from "../lib/supabase.js";

// ──────────────────── constantes ────────────────────

const TZ = "America/Santo_Domingo";
const PREFIJOS_DO = ["809", "829", "849"];
const NOMBRES_PROHIBIDOS_COMO_APELLIDO = [
  "paciente", "usuario", "cliente", "persona", "user", "null", "undefined",
];
const PATRONES_NOMBRE_SOSPECHOSO = /^[a-z]?(bbb|xxx|yyy|aaa|zzz|abc|test|prueba)$/i;

// ──────────────────── helpers de fecha/hora ────────────────────

function hoyRD(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

function ahoraRD(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
}

function fmtHora(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-DO", {
    timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function fmtFecha(fecha: string): string {
  return new Date(fecha + "T12:00:00Z").toLocaleDateString("es-DO", {
    timeZone: "UTC", weekday: "long", day: "numeric", month: "long",
  });
}

/**
 * Normaliza un timestamp del LLM. Si falta zona horaria, asume hora RD (-04:00).
 * Retorna null si el formato es irreconocible.
 */
function normalizarIniciaEn(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/);
  if (!m) return null;
  const tieneOffset = /([+-]\d{2}:?\d{2}|Z)$/.test(raw);
  const fecha = m[1];
  const hora = m[2].length === 5 ? `${m[2]}:00` : m[2];
  const normalizado = tieneOffset ? raw : `${fecha}T${hora}-04:00`;
  const d = new Date(normalizado);
  if (isNaN(d.getTime())) return null;
  return normalizado;
}

// ──────────────────── validaciones ────────────────────

export function validarTelefonoDO(raw: string): {
  valido: boolean; normalizado: string | null; motivo?: string;
} {
  if (!raw || typeof raw !== "string") {
    return { valido: false, normalizado: null, motivo: "teléfono vacío" };
  }
  let digitos = raw.replace(/\D/g, "");
  if (digitos.length === 11 && digitos.startsWith("1")) digitos = digitos.slice(1);
  if (digitos.length !== 10) {
    return {
      valido: false, normalizado: null,
      motivo: `tiene ${digitos.length} dígitos, se esperan 10`,
    };
  }
  const prefijo = digitos.slice(0, 3);
  if (!PREFIJOS_DO.includes(prefijo)) {
    return {
      valido: false, normalizado: null,
      motivo: `prefijo ${prefijo} no es dominicano (use 809/829/849)`,
    };
  }
  return { valido: true, normalizado: "+1" + digitos };
}

export function validarCedulaDominicana(input: string): {
  valida: boolean; normalizada: string | null;
} {
  if (!input) return { valida: false, normalizada: null };
  const digitos = input.replace(/\D/g, "");
  if (digitos.length !== 11) return { valida: false, normalizada: null };
  const mult = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) {
    let p = parseInt(digitos[i]) * mult[i];
    if (p >= 10) p = Math.floor(p / 10) + (p % 10);
    suma += p;
  }
  const v = (10 - (suma % 10)) % 10;
  if (v !== parseInt(digitos[10])) return { valida: false, normalizada: null };
  return {
    valida: true,
    normalizada: `${digitos.slice(0,3)}-${digitos.slice(3,10)}-${digitos.slice(10)}`,
  };
}

function validarNombre(raw: string): {
  valido: boolean; nombre: string; apellido: string; motivo?: string;
} {
  if (!raw || typeof raw !== "string") {
    return { valido: false, nombre: "", apellido: "", motivo: "nombre vacío" };
  }
  const limpio = raw.trim().replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ");
  if (limpio.length < 2) return { valido: false, nombre: "", apellido: "", motivo: "muy corto" };
  if (limpio.length > 100) return { valido: false, nombre: "", apellido: "", motivo: "muy largo" };
  if (!/^[\p{L}\s'\-.]+$/u.test(limpio)) {
    return { valido: false, nombre: "", apellido: "", motivo: "caracteres inválidos" };
  }
  const partes = limpio.split(" ");
  const pNombre = partes[0];
  let pApellido = partes.slice(1).join(" ");
  if (NOMBRES_PROHIBIDOS_COMO_APELLIDO.includes(pApellido.toLowerCase())) pApellido = "";
  if (PATRONES_NOMBRE_SOSPECHOSO.test(pApellido)) {
    console.warn(`[VALIDACION] apellido sospechoso descartado: "${pApellido}"`);
    pApellido = "";
  }
  return { valido: true, nombre: pNombre, apellido: pApellido };
}

function sanitizeBusqueda(texto: string): string {
  return texto.trim().replace(/[*(),\\]/g, "").slice(0, 60);
}

// ──────────────────── helpers de dominio ────────────────────

async function detectarCitaDuplicada(
  pacienteId: string, doctorClinicaId: string, fechaISO: string
): Promise<{ duplicada: boolean; codigo?: string; hora?: string }> {
  const fecha = fechaISO.split("T")[0];
  const desdeISO = `${fecha}T00:00:00-04:00`;
  const hastaISO = `${fecha}T23:59:59-04:00`;
  const r = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    paciente_id: `eq.${pacienteId}`,
    doctor_clinica_id: `eq.${doctorClinicaId}`,
    estado: "in.(pendiente,confirmada)",
    inicia_en: `gte.${desdeISO}`,
    select: "codigo,inicia_en", order: "inicia_en.asc", limit: "5",
  });
  const m = (r.data || []).find((c: any) => c.inicia_en >= desdeISO && c.inicia_en <= hastaISO);
  return m ? { duplicada: true, codigo: m.codigo, hora: fmtHora(m.inicia_en) } : { duplicada: false };
}

async function resolverServicio(dcId: string, servicioId?: string): Promise<string | null> {
  if (servicioId) {
    const check = await supabase<any[]>("GET", "/rest/v1/servicios", null, {
      id: `eq.${servicioId}`, doctor_clinica_id: `eq.${dcId}`, select: "id", limit: "1",
    });
    if (check.data?.length) return servicioId;
  }
  const srvs = await supabase<any[]>("GET", "/rest/v1/servicios", null, {
    doctor_clinica_id: `eq.${dcId}`, activo: "eq.true",
    invisible_para_pacientes: "eq.false", select: "id,nombre,tipo", limit: "5",
  });
  const srv = srvs.data?.find((s: any) => s.tipo === "primera_vez") ?? srvs.data?.[0];
  return srv?.id ?? null;
}

async function slotsParaFecha(dcId: string, srvId: string, fecha: string) {
  const result = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: dcId, p_fecha: fecha, p_servicio_id: srvId,
  });
  const hoy = hoyRD();
  const ahora = ahoraRD();
  return (result.data ?? [])
    .filter((s: any) => {
      if (fecha === hoy) {
        const t = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: TZ }));
        if (t <= ahora) return false;
      }
      return true;
    })
    .slice(0, 20)
    .map((s: any) => ({ inicia_en: s.inicia_en, hora: fmtHora(s.inicia_en) }));
}

// ──────────────────── BUSCAR DOCTOR ────────────────────

export async function exec_buscar_doctor(args: { texto: string }): Promise<string> {
  if (!args?.texto || typeof args.texto !== "string") {
    return JSON.stringify({ encontrado: false, mensaje: "Texto inválido" });
  }
  const c = sanitizeBusqueda(args.texto);
  if (c.length < 2) return JSON.stringify({ encontrado: false, mensaje: "Texto muy corto" });

  if (/^\d+$/.test(c)) {
    const r = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
      extension: `eq.${c}`, activo: "eq.true",
      select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
      limit: "1",
    });
    if (r.data?.[0]) return JSON.stringify({ encontrado: true, doctor: r.data[0] });
    return JSON.stringify({ encontrado: false, mensaje: "No se encontró doctor con esa extensión" });
  }

  const palabras = c.split(/\s+/).filter(w => w.length >= 2);

  if (palabras.length >= 2) {
    const r = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
      activo: "eq.true",
      or: `(nombre.ilike.*${palabras[0]}*,apellido.ilike.*${palabras[0]}*)`,
      select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
      limit: "10",
    });
    if (r.data?.length) {
      const matches = r.data.filter(d => {
        const completo = `${d.nombre} ${d.apellido}`.toLowerCase();
        return palabras.every(p => completo.includes(p.toLowerCase()));
      });
      if (matches.length === 1) return JSON.stringify({ encontrado: true, doctor: matches[0] });
      if (matches.length > 1)  return JSON.stringify({ encontrado: true, multiples: matches });
    }
    return JSON.stringify({ encontrado: false, mensaje: "No se encontró ningún doctor con ese nombre" });
  }

  const palabra = palabras[0];
  const r = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
    activo: "eq.true",
    or: `(nombre.ilike.*${palabra}*,apellido.ilike.*${palabra}*)`,
    select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
    limit: "5",
  });
  if (!r.data?.length) {
    return JSON.stringify({ encontrado: false, mensaje: `No se encontró ningún doctor con "${c}"` });
  }
  if (r.data.length === 1) {
    return JSON.stringify({
      encontrado: true, sugerencia: true, doctor: r.data[0],
      mensaje: `Encontré al Dr. ${r.data[0].nombre} ${r.data[0].apellido}. Confirma antes de continuar.`,
    });
  }
  return JSON.stringify({
    encontrado: true, sugerencia: true, multiples: r.data,
    mensaje: "Hay varios doctores que coinciden. Pregunta al usuario cuál es el correcto.",
  });
}

// ──────────────────── BUSCAR SEDES ────────────────────

export async function exec_buscar_sedes(args: { doctor_id: string }): Promise<string> {
  const r = await supabase<any[]>("GET", "/rest/v1/doctor_clinica", null, {
    doctor_id: `eq.${args.doctor_id}`, activo: "eq.true",
    select: "id,clinicas(nombre,ciudad,direccion,telefono)",
  });
  return JSON.stringify({ sedes: r.data ?? [] });
}

// ──────────────────── BUSCAR SERVICIOS ────────────────────

export async function exec_buscar_servicios(args: { doctor_clinica_id: string }): Promise<string> {
  const r = await supabase<any[]>("GET", "/rest/v1/servicios", null, {
    doctor_clinica_id: `eq.${args.doctor_clinica_id}`,
    activo: "eq.true", invisible_para_pacientes: "eq.false",
    select: "id,nombre,duracion_min,tipo",
  });
  return JSON.stringify({ servicios: r.data ?? [] });
}

// ──────────────────── CONSULTAR INFO ────────────────────

export async function exec_consultar_info(args: {
  doctor_clinica_id: string; fecha?: string; dia_semana?: string;
}): Promise<string> {
  const srvId = await resolverServicio(args.doctor_clinica_id);
  if (!srvId) return JSON.stringify({ error: "No hay servicios en esta sede" });

  let fechaBuscar = args.fecha;
  if (!fechaBuscar && args.dia_semana) {
    const diasMap: Record<string, number> = {
      domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3,
      jueves: 4, viernes: 5, sabado: 6, sábado: 6,
    };
    const target = diasMap[args.dia_semana.toLowerCase()];
    if (target !== undefined) {
      const hoy = new Date(ahoraRD());
      for (let i = 1; i <= 14; i++) {
        const d = new Date(hoy);
        d.setDate(d.getDate() + i);
        if (d.getDay() === target) { fechaBuscar = d.toISOString().split("T")[0]; break; }
      }
    }
  }

  if (fechaBuscar) {
    const slots = await slotsParaFecha(args.doctor_clinica_id, srvId, fechaBuscar);
    const horaDe = (s: any) => new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: TZ })).getHours();
    const tieneNoche = slots.some(s => horaDe(s) >= 17);
    const tieneTarde = slots.some(s => horaDe(s) >= 12 && horaDe(s) < 17);
    const tieneMañana = slots.some(s => horaDe(s) < 12);
    return JSON.stringify({
      fecha: fechaBuscar, fecha_texto: fmtFecha(fechaBuscar),
      total_horarios: slots.length, horarios: slots.map(s => s.hora),
      atiende_mañana: tieneMañana, atiende_tarde: tieneTarde, atiende_noche: tieneNoche,
      nota: slots.length === 0 ? "No hay horarios disponibles para ese día"
        : tieneNoche ? "Sí atiende en horario nocturno" : "Solo atiende en horario diurno",
    });
  }

  const diasR = await rpc<any>("fn_dias_disponibles", {
    p_doctor_clinica_id: args.doctor_clinica_id, p_servicio_id: srvId,
    p_dias_adelante: 14, p_max_resultados: 7,
  });
  const dias = (diasR.data ?? []).filter((d: any) => d.fecha > hoyRD());
  return JSON.stringify({
    proximos_dias: dias.map((d: any) => ({
      fecha: d.fecha, dia_texto: fmtFecha(d.fecha), total_slots: d.total_slots,
    })),
    total_dias_disponibles: dias.length,
    nota: dias.length === 0 ? "No hay disponibilidad en los próximos 14 días"
      : `Hay ${dias.length} días con disponibilidad`,
  });
}

// ──────────────────── BUSCAR DISPONIBILIDAD ────────────────────

export async function exec_buscar_disponibilidad(args: {
  doctor_clinica_id: string; servicio_id?: string;
}): Promise<string> {
  const srvId = await resolverServicio(args.doctor_clinica_id, args.servicio_id);
  if (!srvId) return JSON.stringify({ dias: [], error: "No hay servicios en esta sede" });
  const result = await rpc<any>("fn_dias_disponibles", {
    p_doctor_clinica_id: args.doctor_clinica_id, p_servicio_id: srvId,
    p_dias_adelante: 14, p_max_resultados: 5,
  });
  const dias = (result.data ?? []).filter((d: any) => d.fecha > hoyRD());
  return JSON.stringify({
    servicio_id_usado: srvId,
    dias: dias.map((d: any) => ({
      fecha: d.fecha, dia_texto: fmtFecha(d.fecha), total_slots: d.total_slots,
    })),
  });
}

// ──────────────────── BUSCAR HORARIOS ────────────────────

export async function exec_buscar_horarios(args: {
  doctor_clinica_id: string; servicio_id?: string; fecha: string;
}): Promise<string> {
  const srvId = await resolverServicio(args.doctor_clinica_id, args.servicio_id);
  if (!srvId) return JSON.stringify({ error: "No hay servicios" });
  const slots = await slotsParaFecha(args.doctor_clinica_id, srvId, args.fecha);
  return JSON.stringify({
    fecha: args.fecha, servicio_id_usado: srvId,
    instruccion: "Cuando el paciente elija una hora, usa el campo inicia_en exacto de ese slot. NO vuelvas a llamar buscar_horarios.",
    horarios: slots.map(s => ({ hora: s.hora, inicia_en: s.inicia_en })),
  });
}

// ──────────────────── AGENDAR CITA ────────────────────

export async function exec_agendar_cita(args: {
  doctor_clinica_id: string; servicio_id?: string; inicia_en: string;
  nombre: string; telefono: string; motivo?: string; primera_vez?: boolean;
}, chatId?: string): Promise<string> {

  const tel = validarTelefonoDO(args.telefono);
  if (!tel.valido) {
    console.log(`[AGENDAR] tel inválido (${tel.motivo}): "${args.telefono}"`);
    return JSON.stringify({
      exito: false,
      error: `Teléfono inválido: ${tel.motivo}. Pida al paciente repetir su número de 10 dígitos con prefijo 809/829/849.`,
    });
  }

  const nom = validarNombre(args.nombre);
  if (!nom.valido) {
    console.log(`[AGENDAR] nombre inválido (${nom.motivo}): "${args.nombre}"`);
    return JSON.stringify({
      exito: false,
      error: `Nombre inválido: ${nom.motivo}. Pida el nombre completo del paciente.`,
    });
  }

  const iniciaNormalizado = normalizarIniciaEn(args.inicia_en);
  if (!iniciaNormalizado) {
    console.log(`[AGENDAR] inicia_en irreconocible: "${args.inicia_en}"`);
    return JSON.stringify({ exito: false, error: "Horario inválido" });
  }
  if (new Date(iniciaNormalizado).getTime() <= Date.now()) {
    return JSON.stringify({ exito: false, error: "No se puede agendar en el pasado." });
  }

  console.log(`[AGENDAR] chat=${chatId} tel=${tel.normalizado} nombre="${nom.nombre} ${nom.apellido}" inicia="${args.inicia_en}"→"${iniciaNormalizado}"`);

  const srvId = await resolverServicio(args.doctor_clinica_id, args.servicio_id);
  if (!srvId) return JSON.stringify({ exito: false, error: "No hay servicios configurados" });

  const motivo = args.primera_vez === false ? "Seguimiento" : "Primera consulta";

  const pac = await rpc<any>("fn_get_or_create_paciente", {
    p_telefono: tel.normalizado, p_nombre: nom.nombre, p_apellido: nom.apellido,
    p_cedula: null, p_fecha_nacimiento: null, p_sexo: null, p_zona: null,
  });
  if (!pac.data?.[0]?.paciente_id) {
    console.error(`[AGENDAR] fn_get_or_create_paciente falló tel=${tel.normalizado}`);
    return JSON.stringify({ exito: false, error: "No se pudo registrar al paciente." });
  }
  const pacienteId = pac.data[0].paciente_id;

  const dup = await detectarCitaDuplicada(pacienteId, args.doctor_clinica_id, iniciaNormalizado);
  if (dup.duplicada) {
    return JSON.stringify({
      exito: false,
      error: `Este paciente ya tiene una cita ese día a las ${dup.hora} con código ${dup.codigo}. Use reagendar_cita para cambiar horario.`,
      codigo_existente: dup.codigo, hora_existente: dup.hora,
    });
  }

  const cita = await rpc<any>("fn_agendar_cita", {
    p_doctor_clinica_id: args.doctor_clinica_id,
    p_paciente_id: pacienteId, p_servicio_id: srvId,
    p_inicia_en: iniciaNormalizado, p_motivo: motivo,
    p_canal: "telegram", p_creado_por: null,
  });

  // Detectar exclusion_violation (23P01) que burbujea como HTTP 400 sin data
  const hubo23P01 = cita.status === 400 && !cita.data;
  const rpcFallo  = !cita.data?.[0]?.exito;

  if (hubo23P01 || rpcFallo) {
    const errorMsg = hubo23P01
      ? "Ese horario choca con otra cita existente."
      : (cita.data?.[0]?.mensaje ?? "Ese horario no está disponible.");

    if (hubo23P01) {
      console.error(`[AGENDAR] EXCLUDE VIOLATION (23P01) inicia="${iniciaNormalizado}". fn_slots_con_espacio ofreció un slot que colisiona con una cita viva. Revisa sincronización agenda_slots <-> citas.`);
    } else {
      console.log(`[AGENDAR] FALLÓ inicia="${iniciaNormalizado}" → ${errorMsg}`);
    }

    // Cargar alternativas reales del MISMO día para que el LLM las ofrezca.
    let alternativas: Array<{ hora: string; inicia_en: string }> = [];
    try {
      const fecha = iniciaNormalizado.split("T")[0];
      const otros = await slotsParaFecha(args.doctor_clinica_id, srvId, fecha);
      alternativas = otros
        .filter(s => s.inicia_en !== iniciaNormalizado)
        .slice(0, 6);
    } catch (e: any) {
      console.warn(`[AGENDAR] no pude cargar alternativas: ${e.message}`);
    }

    return JSON.stringify({
      exito: false,
      error: errorMsg,
      alternativas,
      instruccion_bot: alternativas.length
        ? `El horario solicitado NO está disponible. Dile al paciente simplemente que esa hora no está disponible (sin especular por qué, sin decir "se acaba de ocupar" ni "la tomaron ahora") y ofrécele estas alternativas del mismo día: ${alternativas.map(a => a.hora).join(", ")}. Cuando elija una, usa su inicia_en exacto para llamar agendar_cita de nuevo.`
        : "Dile al paciente que ese horario no está disponible y que no hay más horarios libres ese día. Ofrécele buscar en otro día con buscar_disponibilidad.",
    });
  }

  console.log(`[AGENDAR] OK código=${cita.data[0].codigo} paciente=${pacienteId}`);
  return JSON.stringify({ exito: true, codigo: cita.data[0].codigo });
}

// ──────────────────── CANCELAR CITA ────────────────────

export async function exec_cancelar_cita(args: { codigo: string }): Promise<string> {
  let code = args.codigo.trim().toUpperCase().replace(/^CITA[\s-]*/i, "").replace(/\s+/g, "");
  if (code.length < 4) return JSON.stringify({ exito: false, error: "Código inválido" });
  code = "CITA-" + code;
  const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    codigo: `eq.${code}`, select: "id,estado", limit: "1",
  });
  if (!found.data?.[0]) return JSON.stringify({ exito: false, error: `No existe cita ${code}` });
  if (!["pendiente", "confirmada"].includes(found.data[0].estado)) {
    return JSON.stringify({ exito: false, error: `Cita en estado: ${found.data[0].estado}` });
  }
  await rpc<any>("fn_cancelar_cita", {
    p_cita_id: found.data[0].id, p_motivo_cancel: "cancelada_paciente",
    p_cancelado_por: null, p_penalizar_paciente: null,
  });
  console.log(`[CANCELAR] ${code}`);
  return JSON.stringify({ exito: true, codigo: code });
}

// ──────────────────── CONSULTAR CITA ────────────────────

export async function exec_consultar_cita(args: { codigo: string }): Promise<string> {
  let code = args.codigo.trim().toUpperCase().replace(/^CITA[\s-]*/i, "").replace(/\s+/g, "");
  if (code.length < 4) return JSON.stringify({ error: "Código inválido" });
  code = "CITA-" + code;
  const r = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    codigo: `eq.${code}`,
    select: "id,codigo,inicia_en,termina_en,motivo,estado,pacientes(nombre,apellido,telefono),servicios(nombre)",
    limit: "1",
  });
  if (!r.data?.[0]) return JSON.stringify({ encontrada: false, error: `No existe cita ${code}` });
  const c = r.data[0];
  return JSON.stringify({
    encontrada: true, codigo: c.codigo, estado: c.estado,
    fecha: fmtFecha(c.inicia_en.split("T")[0]), hora: fmtHora(c.inicia_en),
    paciente: c.pacientes ? `${c.pacientes.nombre} ${c.pacientes.apellido}` : "N/A",
    servicio: c.servicios?.nombre ?? "Consulta", motivo: c.motivo,
  });
}

// ──────────────────── REAGENDAR CITA ────────────────────

export async function exec_reagendar_cita(args: {
  codigo: string; nuevo_inicia_en: string;
}): Promise<string> {
  let code = args.codigo.trim().toUpperCase().replace(/^CITA[\s-]*/i, "").replace(/\s+/g, "");
  if (code.length < 4) return JSON.stringify({ exito: false, error: "Código inválido" });
  code = "CITA-" + code;

  const nuevoNormalizado = normalizarIniciaEn(args.nuevo_inicia_en);
  if (!nuevoNormalizado) return JSON.stringify({ exito: false, error: "Nueva fecha/hora inválida" });
  if (new Date(nuevoNormalizado).getTime() <= Date.now()) {
    return JSON.stringify({ exito: false, error: "La nueva fecha debe ser futura" });
  }
  console.log(`[REAGENDAR] ${code} nuevo="${args.nuevo_inicia_en}"→"${nuevoNormalizado}"`);

  const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    codigo: `eq.${code}`,
    select: "id,estado,doctor_clinica_id,servicio_id,paciente_id,motivo,inicia_en",
    limit: "1",
  });
  if (!found.data?.[0]) return JSON.stringify({ exito: false, error: `No existe cita ${code}` });
  const citaOriginal = found.data[0];

  if (!["pendiente", "confirmada"].includes(citaOriginal.estado)) {
    return JSON.stringify({ exito: false, error: `Cita en estado: ${citaOriginal.estado}` });
  }
  if (citaOriginal.inicia_en === nuevoNormalizado) {
    return JSON.stringify({ exito: false, error: "La nueva hora es la misma que la actual" });
  }

  const fechaStr = nuevoNormalizado.split("T")[0];
  const slots = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: citaOriginal.doctor_clinica_id,
    p_servicio_id: citaOriginal.servicio_id, p_fecha: fechaStr,
  });
  const disponible = (slots.data || []).find((s: any) => {
    const slotIso = s.inicia_en || s.inicia;
    return slotIso && slotIso.startsWith(nuevoNormalizado.substring(0, 16));
  });
  if (!disponible) return JSON.stringify({ exito: false, error: "El nuevo horario no está disponible." });

  const cancelado = await rpc<any>("fn_cancelar_cita", {
    p_cita_id: citaOriginal.id, p_motivo_cancel: "reagendada",
    p_cancelado_por: null, p_penalizar_paciente: null,
  });
  if (cancelado.status >= 400) {
    return JSON.stringify({ exito: false, error: "No se pudo liberar el horario anterior" });
  }

  const nueva = await rpc<any>("fn_agendar_cita", {
    p_doctor_clinica_id: citaOriginal.doctor_clinica_id,
    p_paciente_id: citaOriginal.paciente_id,
    p_servicio_id: citaOriginal.servicio_id,
    p_inicia_en: nuevoNormalizado, p_motivo: citaOriginal.motivo,
    p_canal: "telegram", p_creado_por: null,
  });
  if (!nueva.data?.[0]?.exito) {
    const errorMsg = nueva.data?.[0]?.mensaje ?? "Error desconocido";
    console.error(`[REAGENDAR] ${code} cancelada pero nueva falló: ${errorMsg}`);
    return JSON.stringify({
      exito: false,
      error: `La cita anterior fue liberada pero el nuevo horario ya no está disponible: ${errorMsg}.`,
      cita_original_cancelada: true,
    });
  }
  console.log(`[REAGENDAR] ${code} → ${nueva.data[0].codigo}`);
  return JSON.stringify({
    exito: true, codigo_anterior: code, codigo_nuevo: nueva.data[0].codigo,
    nueva_fecha: fmtFecha(fechaStr), nueva_hora: fmtHora(nuevoNormalizado),
  });
}

// ──────────────────── DISPATCH con timing + error handling ────────────────────

export async function ejecutarTool(name: string, args: any, chatId?: string): Promise<string> {
  const t0 = Date.now();
  console.log(`[TOOL] ${name}(${JSON.stringify(args).slice(0, 150)})`);
  try {
    let result: string;
    switch (name) {
      case "buscar_doctor":         result = await exec_buscar_doctor(args); break;
      case "buscar_sedes":          result = await exec_buscar_sedes(args); break;
      case "buscar_servicios":      result = await exec_buscar_servicios(args); break;
      case "consultar_info":        result = await exec_consultar_info(args); break;
      case "buscar_disponibilidad": result = await exec_buscar_disponibilidad(args); break;
      case "buscar_horarios":       result = await exec_buscar_horarios(args); break;
      case "agendar_cita":          result = await exec_agendar_cita(args, chatId); break;
      case "cancelar_cita":         result = await exec_cancelar_cita(args); break;
      case "consultar_cita":        result = await exec_consultar_cita(args); break;
      case "reagendar_cita":        result = await exec_reagendar_cita(args); break;
      default: result = JSON.stringify({ error: `Herramienta desconocida: ${name}` });
    }
    console.log(`[TOOL] ${name} OK (${Date.now() - t0}ms)`);
    return result;
  } catch (err: any) {
    console.error(`[TOOL ERROR] ${name} (${Date.now() - t0}ms):`, err.message);
    return JSON.stringify({ error: "Error técnico" });
  }
}
