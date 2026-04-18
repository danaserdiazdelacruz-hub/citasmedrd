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

  if (/^\d+$/.test(c)) {
    const r = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
      extension: `eq.${c}`, activo: "eq.true",
      select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
      limit: "1",
    });
    if (r.data?.[0]) return JSON.stringify({ encontrado: true, doctor: r.data[0] });
  }

  const r = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
    activo: "eq.true",
    or: `(nombre.ilike.*${c}*,apellido.ilike.*${c}*)`,
    select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
    limit: "5",
  });

  if (!r.data?.length) {
    for (const word of c.split(/\s+/).filter(w => w.length >= 3)) {
      const r2 = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
        activo: "eq.true", or: `(nombre.ilike.*${word}*,apellido.ilike.*${word}*)`,
        select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
        limit: "5",
      });
      if (r2.data?.length) {
        return r2.data.length === 1
          ? JSON.stringify({ encontrado: true, doctor: r2.data[0] })
          : JSON.stringify({ encontrado: true, multiples: r2.data });
      }
    }
    return JSON.stringify({ encontrado: false, mensaje: "No se encontró doctor" });
  }

  return r.data.length === 1
    ? JSON.stringify({ encontrado: true, doctor: r.data[0] })
    : JSON.stringify({ encontrado: true, multiples: r.data });
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
  return JSON.stringify({ fecha: args.fecha, servicio_id_usado: srvId, horarios: slots });
}

// ──────────────────── AGENDAR CITA ────────────────────

export async function exec_agendar_cita(args: {
  doctor_clinica_id: string; servicio_id?: string; inicia_en: string;
  nombre: string; telefono: string; motivo: string;
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
  if (!args.motivo || args.motivo.trim().length < 2) {
    return JSON.stringify({ exito: false, error: "Motivo de consulta requerido." });
  }

  const srvId = await resolverServicio(args.doctor_clinica_id, args.servicio_id);
  if (!srvId) return JSON.stringify({ exito: false, error: "No hay servicios configurados" });

  const parts = args.nombre.trim().split(" ");
  const pac = await rpc<any>("fn_get_or_create_paciente", {
    p_telefono: "+1" + tel,
    p_nombre: parts[0] ?? "Paciente",
    p_apellido: parts.slice(1).join(" ") || "Paciente",
    p_cedula: null, p_fecha_nacimiento: null, p_sexo: null, p_zona: null,
  });
  if (!pac.data?.[0]?.paciente_id) {
    return JSON.stringify({ exito: false, error: "No se pudo registrar al paciente." });
  }

  const cita = await rpc<any>("fn_agendar_cita", {
    p_doctor_clinica_id: args.doctor_clinica_id,
    p_paciente_id: pac.data[0].paciente_id,
    p_servicio_id: srvId,
    p_inicia_en: args.inicia_en,
    p_motivo: args.motivo,
    p_canal: "telegram",
    p_creado_por: chatId ?? null,
  });

  if (!cita.data?.[0]?.exito) {
    return JSON.stringify({ exito: false, error: cita.data?.[0]?.mensaje ?? "Horario no disponible." });
  }
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
      default: return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
    }
  } catch (err: any) {
    console.error(`[TOOL ERROR] ${name}:`, err.message);
    return JSON.stringify({ error: "Error técnico" });
  }
}
