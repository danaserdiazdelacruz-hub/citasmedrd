// src/bot/toolExecutors.ts — Ejecutores de herramientas
// Cada función consulta Supabase y devuelve resultado para Claude

import { supabase, rpc } from "../lib/supabase.js";

// ──────────────────────────────────────────────────
// BUSCAR DOCTOR
// ──────────────────────────────────────────────────

export async function exec_buscar_doctor(args: { texto: string }): Promise<string> {
  const c = args.texto.trim();
  if (!c || c.length < 2) return JSON.stringify({ error: "Texto muy corto para buscar" });

  // Por extensión
  if (/^\d+$/.test(c)) {
    const r = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
      extension: `eq.${c}`, activo: "eq.true",
      select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
      limit: "1",
    });
    if (Array.isArray(r.data) && r.data[0]) return JSON.stringify({ encontrado: true, doctor: r.data[0] });
  }

  // Por nombre/apellido
  const r = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
    activo: "eq.true",
    or: `(nombre.ilike.*${c}*,apellido.ilike.*${c}*)`,
    select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
    limit: "5",
  });

  if (!r.data || !Array.isArray(r.data) || r.data.length === 0) {
    // Intentar palabra por palabra
    const words = c.split(/\s+/).filter(w => w.length >= 3);
    for (const word of words) {
      const r2 = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
        activo: "eq.true",
        or: `(nombre.ilike.*${word}*,apellido.ilike.*${word}*)`,
        select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
        limit: "5",
      });
      if (r2.data && Array.isArray(r2.data) && r2.data.length > 0) {
        if (r2.data.length === 1) return JSON.stringify({ encontrado: true, doctor: r2.data[0] });
        return JSON.stringify({ encontrado: true, multiples: r2.data });
      }
    }
    return JSON.stringify({ encontrado: false, mensaje: "No se encontró ningún doctor con ese nombre o extensión" });
  }

  if (r.data.length === 1) return JSON.stringify({ encontrado: true, doctor: r.data[0] });
  return JSON.stringify({ encontrado: true, multiples: r.data });
}

// ──────────────────────────────────────────────────
// BUSCAR SEDES
// ──────────────────────────────────────────────────

export async function exec_buscar_sedes(args: { doctor_id: string }): Promise<string> {
  const r = await supabase<any[]>("GET", "/rest/v1/doctor_clinica", null, {
    doctor_id: `eq.${args.doctor_id}`, activo: "eq.true",
    select: "id,clinicas(nombre,ciudad,direccion,telefono)",
  });
  return JSON.stringify({ sedes: r.data ?? [] });
}

// ──────────────────────────────────────────────────
// BUSCAR SERVICIOS
// ──────────────────────────────────────────────────

export async function exec_buscar_servicios(args: { doctor_clinica_id: string }): Promise<string> {
  const r = await supabase<any[]>("GET", "/rest/v1/servicios", null, {
    doctor_clinica_id: `eq.${args.doctor_clinica_id}`,
    activo: "eq.true", invisible_para_pacientes: "eq.false",
    select: "id,nombre,duracion_min,tipo",
  });
  return JSON.stringify({ servicios: r.data ?? [] });
}

// ──────────────────────────────────────────────────
// BUSCAR DISPONIBILIDAD (días)
// ──────────────────────────────────────────────────

export async function exec_buscar_disponibilidad(args: { doctor_clinica_id: string; servicio_id: string }): Promise<string> {
  const result = await rpc<any>("fn_dias_disponibles", {
    p_doctor_clinica_id: args.doctor_clinica_id,
    p_servicio_id: args.servicio_id,
    p_dias_adelante: 14,
    p_max_resultados: 5,
  });

  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Santo_Domingo" });
  const dias = (result.data ?? []).filter((d: any) => d.fecha > hoy);

  return JSON.stringify({
    dias: dias.map((d: any) => ({
      fecha: d.fecha,
      dia_texto: new Date(d.fecha + "T12:00:00Z").toLocaleDateString("es-DO", {
        timeZone: "UTC", weekday: "long", day: "numeric", month: "long",
      }),
      total_slots: d.total_slots,
    })),
  });
}

// ──────────────────────────────────────────────────
// BUSCAR HORARIOS (slots de un día)
// ──────────────────────────────────────────────────

export async function exec_buscar_horarios(args: { doctor_clinica_id: string; servicio_id: string; fecha: string }): Promise<string> {
  const result = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: args.doctor_clinica_id,
    p_fecha: args.fecha,
    p_servicio_id: args.servicio_id,
  });

  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Santo_Domingo" });
  const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));

  const slots = (result.data ?? [])
    .filter((s: any) => {
      if (args.fecha === hoy) {
        const t = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
        if (t <= ahora) return false;
      }
      // Solo :00, :20, :40 (3 por hora)
      const dt = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
      return dt.getMinutes() % 20 === 0;
    })
    .slice(0, 10)
    .map((s: any) => ({
      inicia_en: s.inicia_en,
      hora: new Date(s.inicia_en).toLocaleTimeString("es-DO", {
        timeZone: "America/Santo_Domingo", hour: "numeric", minute: "2-digit", hour12: true,
      }),
    }));

  return JSON.stringify({ fecha: args.fecha, horarios: slots });
}

// ──────────────────────────────────────────────────
// AGENDAR CITA
// ──────────────────────────────────────────────────

export async function exec_agendar_cita(args: {
  doctor_clinica_id: string; servicio_id: string; inicia_en: string;
  nombre: string; telefono: string; motivo: string;
}): Promise<string> {
  // Validar teléfono
  let tel = args.telefono.replace(/\D/g, "");
  if (tel.length === 11 && tel.startsWith("1")) tel = tel.slice(1);
  if (tel.length !== 10 || !["809","829","849"].includes(tel.slice(0, 3))) {
    return JSON.stringify({ exito: false, error: "Teléfono inválido. Debe tener 10 dígitos y empezar con 809, 829 o 849." });
  }

  // Validar nombre
  if (!args.nombre || args.nombre.trim().length < 3) {
    return JSON.stringify({ exito: false, error: "Se necesita el nombre completo del paciente." });
  }

  // Get or create paciente
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

  // Agendar
  const cita = await rpc<any>("fn_agendar_cita", {
    p_doctor_clinica_id: args.doctor_clinica_id,
    p_paciente_id: pac.data[0].paciente_id,
    p_servicio_id: args.servicio_id,
    p_inicia_en: args.inicia_en,
    p_motivo: args.motivo,
    p_canal: "telegram",
    p_creado_por: null,
  });

  if (!cita.data?.[0]?.exito) {
    return JSON.stringify({ exito: false, error: cita.data?.[0]?.mensaje ?? "Horario no disponible." });
  }

  return JSON.stringify({
    exito: true,
    codigo: cita.data[0].codigo,
    mensaje: "Cita agendada exitosamente",
  });
}

// ──────────────────────────────────────────────────
// CANCELAR CITA
// ──────────────────────────────────────────────────

export async function exec_cancelar_cita(args: { codigo: string }): Promise<string> {
  let code = args.codigo.trim().toUpperCase().replace(/^CITA[\s-]*/i, "").replace(/\s+/g, "");
  if (code.length < 4) return JSON.stringify({ exito: false, error: "Código inválido" });
  code = "CITA-" + code;

  const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    codigo: `eq.${code}`, select: "id,estado", limit: "1",
  });

  if (!found.data?.[0]) {
    return JSON.stringify({ exito: false, error: `No se encontró cita con código ${code}` });
  }

  if (!["pendiente", "confirmada"].includes(found.data[0].estado)) {
    return JSON.stringify({ exito: false, error: `La cita ya está en estado: ${found.data[0].estado}` });
  }

  await rpc<any>("fn_cancelar_cita", {
    p_cita_id: found.data[0].id,
    p_motivo_cancel: "cancelada_paciente",
    p_cancelado_por: null,
    p_penalizar_paciente: null,
  });

  return JSON.stringify({ exito: true, codigo: code, mensaje: "Cita cancelada correctamente" });
}

// ──────────────────────────────────────────────────
// DISPATCH — ejecuta la herramienta correcta
// ──────────────────────────────────────────────────

export async function ejecutarTool(name: string, args: any): Promise<string> {
  console.log(`[TOOL] ${name}(${JSON.stringify(args).slice(0, 100)})`);
  try {
    switch (name) {
      case "buscar_doctor":        return await exec_buscar_doctor(args);
      case "buscar_sedes":         return await exec_buscar_sedes(args);
      case "buscar_servicios":     return await exec_buscar_servicios(args);
      case "buscar_disponibilidad":return await exec_buscar_disponibilidad(args);
      case "buscar_horarios":      return await exec_buscar_horarios(args);
      case "agendar_cita":         return await exec_agendar_cita(args);
      case "cancelar_cita":        return await exec_cancelar_cita(args);
      default: return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
    }
  } catch (err: any) {
    console.error(`[TOOL ERROR] ${name}:`, err.message);
    return JSON.stringify({ error: "Error técnico al ejecutar la herramienta" });
  }
}
