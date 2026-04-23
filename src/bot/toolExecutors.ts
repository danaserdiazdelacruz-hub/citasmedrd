// src/bot/toolExecutors.ts — Ejecutores de 9 herramientas
import { supabase, rpc } from "../lib/supabase.js";

// ──────────────────── helpers ────────────────────

const TZ = "America/Santo_Domingo";

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
 * Valida una cédula dominicana.
 * Formato esperado: 000-0000000-0 o 00000000000 (11 dígitos).
 * Aplica el algoritmo de Luhn mod-10 con multiplicadores [1,2,1,2,...].
 * Retorna { valida: boolean, cedulaNormalizada: string | null }
 */
export function validarCedulaDominicana(input: string): { valida: boolean; normalizada: string | null } {
  if (!input) return { valida: false, normalizada: null };

  // Extraer solo dígitos
  const digitos = input.replace(/\D/g, "");
  if (digitos.length !== 11) return { valida: false, normalizada: null };

  // Algoritmo de validación
  const multiplicadores = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  let suma = 0;

  for (let i = 0; i < 10; i++) {
    let producto = parseInt(digitos[i]) * multiplicadores[i];
    if (producto >= 10) producto = Math.floor(producto / 10) + (producto % 10);
    suma += producto;
  }

  const verificador = (10 - (suma % 10)) % 10;
  const valida = verificador === parseInt(digitos[10]);

  if (!valida) return { valida: false, normalizada: null };

  // Formato canónico: 000-0000000-0
  const normalizada = `${digitos.slice(0, 3)}-${digitos.slice(3, 10)}-${digitos.slice(10)}`;
  return { valida: true, normalizada };
}

/**
 * Verifica si ya existe una cita ACTIVA (pendiente/confirmada)
 * del mismo paciente para el mismo día en la misma sede.
 * Previene doble agendamiento.
 */
async function detectarCitaDuplicada(
  pacienteId: string,
  doctorClinicaId: string,
  fechaISO: string
): Promise<{ duplicada: boolean; codigo?: string; hora?: string }> {
  const fecha = fechaISO.split("T")[0];
  const desdeISO = `${fecha}T00:00:00-04:00`;
  const hastaISO = `${fecha}T23:59:59-04:00`;

  const r = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    paciente_id: `eq.${pacienteId}`,
    doctor_clinica_id: `eq.${doctorClinicaId}`,
    estado: "in.(pendiente,confirmada)",
    inicia_en: `gte.${desdeISO}`,
    select: "codigo,inicia_en",
    order: "inicia_en.asc",
    limit: "5",
  });

  const enMismoDia = (r.data || []).find((c: any) => {
    return c.inicia_en >= desdeISO && c.inicia_en <= hastaISO;
  });

  if (enMismoDia) {
    return {
      duplicada: true,
      codigo: enMismoDia.codigo,
      hora: fmtHora(enMismoDia.inicia_en),
    };
  }
  return { duplicada: false };
}

/** Auto-detecta servicio válido para un doctor_clinica_id */
async function resolverServicio(dcId: string, servicioId?: string): Promise<string | null> {
  if (servicioId) {
    const check = await supabase<any[]>("GET", "/rest/v1/servicios", null, {
      id: `eq.${servicioId}`, doctor_clinica_id: `eq.${dcId}`, select: "id", limit: "1",
    });
    if (check.data?.length) return servicioId;
  }
  console.log(`[FIX] Auto-detectando servicio para dc=${dcId}`);
  const srvs = await supabase<any[]>("GET", "/rest/v1/servicios", null, {
    doctor_clinica_id: `eq.${dcId}`, activo: "eq.true",
    invisible_para_pacientes: "eq.false", select: "id,nombre,tipo", limit: "5",
  });
  const srv = srvs.data?.find((s: any) => s.tipo === "primera_vez") ?? srvs.data?.[0];
  if (srv) {
    console.log(`[FIX] Servicio: ${srv.nombre} (${srv.id})`);
    return srv.id;
  }
  return null;
}

/** Busca slots filtrados para una fecha */
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
      const dt = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: TZ }));
      return dt.getMinutes() % 20 === 0;
    })
    .slice(0, 10)
    .map((s: any) => ({ inicia_en: s.inicia_en, hora: fmtHora(s.inicia_en) }));
}

// ──────────────────── BUSCAR DOCTOR ────────────────────

export async function exec_buscar_doctor(args: { texto: string }): Promise<string> {
  const c = args.texto.trim();
  if (!c || c.length < 2) return JSON.stringify({ encontrado: false, mensaje: "Texto muy corto" });

  // Método 1: código de extensión numérico (exacto)
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

  // Método 2: nombre + apellido juntos (2+ palabras) — buscar y filtrar que TODAS estén presentes
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

  // Método 3: una sola palabra — buscar por nombre O apellido y devolver sugerencias para que el bot confirme con el usuario
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

  // Si hay exactamente 1 coincidencia, devolver como sugerencia para confirmar con el usuario
  if (r.data.length === 1) {
    return JSON.stringify({
      encontrado: true,
      sugerencia: true,
      doctor: r.data[0],
      mensaje: `Encontré al Dr. ${r.data[0].nombre} ${r.data[0].apellido}. Confirma con el usuario si es el correcto antes de continuar.`,
    });
  }

  // Múltiples coincidencias — devolver lista para que el bot pregunte al usuario
  return JSON.stringify({
    encontrado: true,
    sugerencia: true,
    multiples: r.data,
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

// ──────────────────── CONSULTAR INFO (sin agendar) ────────────────────

export async function exec_consultar_info(args: {
  doctor_clinica_id: string; fecha?: string; dia_semana?: string;
}): Promise<string> {
  const srvId = await resolverServicio(args.doctor_clinica_id);
  if (!srvId) return JSON.stringify({ error: "No hay servicios en esta sede" });

  // Si piden un día de la semana, buscar la próxima fecha que coincida
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
        if (d.getDay() === target) {
          fechaBuscar = d.toISOString().split("T")[0];
          break;
        }
      }
    }
  }

  // Si tenemos fecha específica, mostrar horarios de ese día
  if (fechaBuscar) {
    const slots = await slotsParaFecha(args.doctor_clinica_id, srvId, fechaBuscar);
    const tieneNoche = slots.some(s => {
      const h = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: TZ })).getHours();
      return h >= 17;
    });
    const tieneTarde = slots.some(s => {
      const h = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: TZ })).getHours();
      return h >= 12 && h < 17;
    });
    const tieneMañana = slots.some(s => {
      const h = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: TZ })).getHours();
      return h < 12;
    });

    return JSON.stringify({
      fecha: fechaBuscar,
      fecha_texto: fmtFecha(fechaBuscar),
      total_horarios: slots.length,
      horarios: slots.map(s => s.hora),
      atiende_mañana: tieneMañana,
      atiende_tarde: tieneTarde,
      atiende_noche: tieneNoche,
      nota: slots.length === 0
        ? "No hay horarios disponibles para ese día"
        : tieneNoche
          ? "Sí atiende en horario nocturno"
          : "Solo atiende en horario diurno (mañana/tarde)",
    });
  }

  // Sin fecha específica: mostrar resumen de próximos días
  const diasR = await rpc<any>("fn_dias_disponibles", {
    p_doctor_clinica_id: args.doctor_clinica_id, p_servicio_id: srvId,
    p_dias_adelante: 14, p_max_resultados: 7,
  });
  const dias = (diasR.data ?? []).filter((d: any) => d.fecha > hoyRD());

  return JSON.stringify({
    proximos_dias: dias.map((d: any) => ({
      fecha: d.fecha,
      dia_texto: fmtFecha(d.fecha),
      total_slots: d.total_slots,
    })),
    total_dias_disponibles: dias.length,
    nota: dias.length === 0
      ? "No hay disponibilidad en los próximos 14 días"
      : `Hay ${dias.length} días con disponibilidad`,
  });
}

// ──────────────────── BUSCAR DISPONIBILIDAD (para agendar) ────────────────────

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

  // Devolver slots con inicia_en explícito + hora legible
  // El LLM DEBE usar el campo inicia_en exacto al llamar agendar_cita
  return JSON.stringify({
    fecha: args.fecha,
    servicio_id_usado: srvId,
    instruccion: "Cuando el paciente elija una hora, usa el campo inicia_en exacto de ese slot para llamar agendar_cita. NO vuelvas a llamar buscar_horarios.",
    horarios: slots.map(s => ({
      hora: s.hora,           // "8:00 a.m." — para mostrar al usuario
      inicia_en: s.inicia_en, // ISO exacto — para pasar a agendar_cita
    })),
  });
}

// ──────────────────── AGENDAR CITA ────────────────────

export async function exec_agendar_cita(args: {
  doctor_clinica_id: string; servicio_id?: string; inicia_en: string;
  nombre: string; telefono: string; motivo?: string; primera_vez?: boolean;
}, chatId?: string): Promise<string> {
  // Validar teléfono
  let tel = args.telefono.replace(/\D/g, "");
  if (tel.length === 11 && tel.startsWith("1")) tel = tel.slice(1);
  if (tel.length !== 10 || !["809", "829", "849"].includes(tel.slice(0, 3))) {
    return JSON.stringify({ exito: false, error: "Teléfono inválido. 10 dígitos, empieza con 809/829/849." });
  }
  if (!args.nombre || args.nombre.trim().length < 2) {
    return JSON.stringify({ exito: false, error: "Nombre del paciente requerido." });
  }

  const srvId = await resolverServicio(args.doctor_clinica_id, args.servicio_id);
  if (!srvId) return JSON.stringify({ exito: false, error: "No hay servicios configurados" });

  // Separar nombre y apellido
  // Strip defensivo: NUNCA guardar "Paciente", "Usuario", "Cliente" como apellido
  const PROHIBIDAS = ['paciente', 'usuario', 'cliente', 'persona'];
  const parts = args.nombre.trim().split(/\s+/);
  const pNombre = parts[0];
  const pApellidoRaw = parts.slice(1).join(" ");
  const pApellido = PROHIBIDAS.includes(pApellidoRaw.toLowerCase()) ? "" : pApellidoRaw;

  // Motivo: basado en primera_vez — NO se pregunta directamente al paciente
  const motivo = args.primera_vez === false ? "Seguimiento" : "Primera consulta";

  const pac = await rpc<any>("fn_get_or_create_paciente", {
    p_telefono: "+1" + tel,
    p_nombre: pNombre,
    p_apellido: pApellido,
    p_cedula: null, p_fecha_nacimiento: null, p_sexo: null, p_zona: null,
  });
  if (!pac.data?.[0]?.paciente_id) {
    return JSON.stringify({ exito: false, error: "No se pudo registrar al paciente." });
  }

  // Detectar duplicados: mismo paciente + misma sede + mismo día
  const pacienteId = pac.data[0].paciente_id;
  const dup = await detectarCitaDuplicada(pacienteId, args.doctor_clinica_id, args.inicia_en);
  if (dup.duplicada) {
    return JSON.stringify({
      exito: false,
      error: `Este paciente ya tiene una cita agendada ese mismo día a las ${dup.hora} con código ${dup.codigo}. Si desea cambiar de horario, use reagendar_cita. Si desea agendar otra consulta adicional en el mismo día, pregunte al paciente si está seguro y explíquele que ya tiene una cita.`,
      codigo_existente: dup.codigo,
      hora_existente: dup.hora,
    });
  }

  const cita = await rpc<any>("fn_agendar_cita", {
    p_doctor_clinica_id: args.doctor_clinica_id,
    p_paciente_id: pac.data[0].paciente_id,
    p_servicio_id: srvId,
    p_inicia_en: args.inicia_en,
    p_motivo: motivo,
    p_canal: "telegram",
    p_creado_por: null,
  });

  console.log(`[AGENDAR] Resultado Supabase:`, JSON.stringify(cita).slice(0, 300));

  if (!cita.data?.[0]?.exito) {
    const errorMsg = cita.data?.[0]?.mensaje ?? "Ese horario no está disponible.";
    console.log(`[AGENDAR] FALLÓ: ${errorMsg}`);
    // Incluir instrucción para el LLM: decir la verdad, no inventar "acaba de ser ocupado"
    return JSON.stringify({
      exito: false,
      error: errorMsg,
      instruccion_bot: "Dile al paciente la verdad: ese horario no está disponible. NO digas 'acaba de ser ocupado' ni 'se tomó en este momento'. Ofrece los otros horarios disponibles del mismo día consultando buscar_horarios.",
    });
  }
  console.log(`[AGENDAR] ÉXITO: código ${cita.data[0].codigo}`);
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
    encontrada: true,
    codigo: c.codigo,
    estado: c.estado,
    fecha: fmtFecha(c.inicia_en.split("T")[0]),
    hora: fmtHora(c.inicia_en),
    paciente: c.pacientes ? `${c.pacientes.nombre} ${c.pacientes.apellido}` : "N/A",
    servicio: c.servicios?.nombre ?? "Consulta",
    motivo: c.motivo,
  });
}

// ──────────────────── REAGENDAR CITA ────────────────────

export async function exec_reagendar_cita(args: {
  codigo: string; nuevo_inicia_en: string;
}): Promise<string> {
  // Normalizar código
  let code = args.codigo.trim().toUpperCase().replace(/^CITA[\s-]*/i, "").replace(/\s+/g, "");
  if (code.length < 4) return JSON.stringify({ exito: false, error: "Código inválido" });
  code = "CITA-" + code;

  // 1) Buscar la cita original
  const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    codigo: `eq.${code}`,
    select: "id,estado,doctor_clinica_id,servicio_id,paciente_id,motivo,inicia_en",
    limit: "1",
  });
  if (!found.data?.[0]) {
    return JSON.stringify({ exito: false, error: `No existe cita ${code}` });
  }
  const citaOriginal = found.data[0];

  if (!["pendiente", "confirmada"].includes(citaOriginal.estado)) {
    return JSON.stringify({
      exito: false,
      error: `No se puede reagendar. La cita está en estado: ${citaOriginal.estado}`,
    });
  }

  // 2) Validar nueva fecha: debe ser futura
  const nuevaDate = new Date(args.nuevo_inicia_en);
  if (isNaN(nuevaDate.getTime())) {
    return JSON.stringify({ exito: false, error: "Fecha/hora nueva inválida" });
  }
  if (nuevaDate.getTime() <= Date.now()) {
    return JSON.stringify({ exito: false, error: "La nueva fecha debe ser futura" });
  }

  // 3) Misma hora que la original? No tiene sentido
  if (citaOriginal.inicia_en === args.nuevo_inicia_en) {
    return JSON.stringify({
      exito: false,
      error: "La nueva hora es la misma que la actual",
    });
  }

  // 4) Verificar que el slot esté disponible (usando fn_slots_con_espacio)
  const fechaStr = args.nuevo_inicia_en.split("T")[0];
  const slots = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: citaOriginal.doctor_clinica_id,
    p_servicio_id: citaOriginal.servicio_id,
    p_fecha: fechaStr,
  });

  const disponible = (slots.data || []).find((s: any) => {
    const slotIso = s.inicia_en || s.inicia;
    return slotIso && slotIso.startsWith(args.nuevo_inicia_en.substring(0, 16));
  });

  if (!disponible) {
    return JSON.stringify({
      exito: false,
      error: "El nuevo horario no está disponible. Por favor elija otro.",
    });
  }

  // 5) Cancelar la cita original
  const cancelado = await rpc<any>("fn_cancelar_cita", {
    p_cita_id: citaOriginal.id,
    p_motivo_cancel: "reagendada",
    p_cancelado_por: null,
    p_penalizar_paciente: null,
  });

  if (cancelado.status >= 400) {
    return JSON.stringify({
      exito: false,
      error: "No se pudo liberar el horario anterior",
    });
  }

  // 6) Crear la nueva cita con los mismos datos
  const nueva = await rpc<any>("fn_agendar_cita", {
    p_doctor_clinica_id: citaOriginal.doctor_clinica_id,
    p_paciente_id: citaOriginal.paciente_id,
    p_servicio_id: citaOriginal.servicio_id,
    p_inicia_en: args.nuevo_inicia_en,
    p_motivo: citaOriginal.motivo,
    p_canal: "telegram",
    p_creado_por: null,
  });

  if (!nueva.data?.[0]?.exito) {
    // Algo salió mal — la cita anterior ya fue cancelada pero la nueva falló
    // Informamos con claridad al usuario
    const errorMsg = nueva.data?.[0]?.mensaje ?? "Error desconocido";
    console.error(`[REAGENDAR] Cita ${code} cancelada pero nueva falló: ${errorMsg}`);
    return JSON.stringify({
      exito: false,
      error: `La cita anterior fue liberada pero el nuevo horario ya no está disponible: ${errorMsg}. Por favor agende una cita nueva con buscar_horarios.`,
      cita_original_cancelada: true,
    });
  }

  console.log(`[REAGENDAR] ${code} → ${nueva.data[0].codigo}`);
  return JSON.stringify({
    exito: true,
    codigo_anterior: code,
    codigo_nuevo: nueva.data[0].codigo,
    nueva_fecha: fmtFecha(fechaStr),
    nueva_hora: fmtHora(args.nuevo_inicia_en),
  });
}

// ──────────────────── DISPATCH ────────────────────

export async function ejecutarTool(name: string, args: any, chatId?: string): Promise<string> {
  console.log(`[TOOL] ${name}(${JSON.stringify(args).slice(0, 120)})`);
  try {
    switch (name) {
      case "buscar_doctor":         return await exec_buscar_doctor(args);
      case "buscar_sedes":          return await exec_buscar_sedes(args);
      case "buscar_servicios":      return await exec_buscar_servicios(args);
      case "consultar_info":        return await exec_consultar_info(args);
      case "buscar_disponibilidad": return await exec_buscar_disponibilidad(args);
      case "buscar_horarios":       return await exec_buscar_horarios(args);
      case "agendar_cita":          return await exec_agendar_cita(args, chatId);
      case "cancelar_cita":         return await exec_cancelar_cita(args);
      case "consultar_cita":        return await exec_consultar_cita(args);
      case "reagendar_cita":        return await exec_reagendar_cita(args);
      default: return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
    }
  } catch (err: any) {
    console.error(`[TOOL ERROR] ${name}:`, err.message);
    return JSON.stringify({ error: "Error técnico" });
  }
}
