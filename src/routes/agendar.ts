// POST /api/agendar
import { Router } from "express";
import { z } from "zod";
import { supabase, rpc } from "../lib/supabase.js";
import { isValidUUID, parseInicia, normalizeTelefono, toLocalTime } from "../lib/dates.js";
import { ENV } from "../lib/env.js";

export const agendarRouter = Router();

const BodySchema = z.object({
  doctor_clinica_id: z.string().refine(isValidUUID, "UUID inválido"),
  servicio_id:       z.string().refine(isValidUUID, "UUID inválido"),
  inicia_en:         z.string().min(1, "Requerido"),
  motivo:            z.string().optional().default(""),
  canal: z.enum(["whatsapp","instagram","telegram","web","call_center","manual"]).default("whatsapp"),
  paciente: z.object({
    telefono:         z.string().min(10, "Teléfono inválido"),
    nombre:           z.string().min(1, "Requerido"),
    apellido:         z.string().min(1, "Requerido"),
    cedula:           z.string().optional().nullable(),
    fecha_nacimiento: z.string().optional().nullable(),
    sexo:             z.enum(["M","F","otro"]).optional().nullable(),
    zona:             z.string().optional().nullable(),
  }),
});

agendarRouter.post("/", async (req, res) => {
  const data = BodySchema.parse(req.body);
  const { doctor_clinica_id: dcId, servicio_id: srvId, canal, paciente } = data;

  // Parsear y validar fecha
  const { utc: iniciaUtc, localDt } = parseInicia(data.inicia_en);
  const ahora = new Date();
  if (localDt <= ahora) {
    res.status(400).json({ error: "No se puede agendar una cita en el pasado." });
    return;
  }

  // Validar servicio pertenece al consultorio
  const srvCheck = await supabase<any[]>("GET", "/rest/v1/servicios", null, {
    id:                `eq.${srvId}`,
    doctor_clinica_id: `eq.${dcId}`,
    activo:            "eq.true",
    select:            "id,invisible_para_pacientes",
    limit:             "1",
  });
  if (!srvCheck.data?.[0]) {
    res.status(403).json({ error: "El servicio no existe o no pertenece a este consultorio." });
    return;
  }
  if (srvCheck.data[0].invisible_para_pacientes && ["whatsapp","instagram","telegram"].includes(canal)) {
    res.status(403).json({ error: "Este servicio no puede agendarse por ese canal." });
    return;
  }

  // Normalizar teléfono
  const telefono = normalizeTelefono(paciente.telefono);
  if (telefono.length < 10) {
    res.status(400).json({ error: `Teléfono inválido: ${telefono}` });
    return;
  }

  // Get-or-create paciente
  const pac = await rpc<any>("fn_get_or_create_paciente", {
    p_telefono:         telefono,
    p_nombre:           paciente.nombre.trim(),
    p_apellido:         paciente.apellido.trim(),
    p_cedula:           paciente.cedula ?? null,
    p_fecha_nacimiento: paciente.fecha_nacimiento ?? null,
    p_sexo:             paciente.sexo ?? null,
    p_zona:             paciente.zona?.trim() ?? null,
  });
  if (pac.status !== 200 || !pac.data?.[0]?.paciente_id) {
    res.status(502).json({ error: "No se pudo identificar al paciente." });
    return;
  }
  const pacienteId = pac.data[0].paciente_id;
  const esNuevo    = pac.data[0].es_nuevo;

  // Agendar
  const cita = await rpc<any>("fn_agendar_cita", {
    p_doctor_clinica_id: dcId,
    p_paciente_id:       pacienteId,
    p_servicio_id:       srvId,
    p_inicia_en:         iniciaUtc,
    p_motivo:            data.motivo,
    p_canal:             canal,
    p_creado_por:        null,
  });
  if (cita.status !== 200 || !cita.data?.[0]) {
    res.status(502).json({ error: "Error de comunicación con la base de datos." });
    return;
  }

  const r = cita.data[0];
  if (!r.exito) {
    res.status(409).json({ exito: false, mensaje: r.mensaje });
    return;
  }

  res.status(201).json({
    exito:             true,
    cita_id:           r.cita_id,
    codigo:            r.codigo,
    paciente_id:       pacienteId,
    es_nuevo_paciente: esNuevo,
    inicia_en:         iniciaUtc,
    termina_en:        r.termina_en,
    hora_inicio:       toLocalTime(iniciaUtc),
    hora_fin:          toLocalTime(r.termina_en),
    mensaje:           r.mensaje,
  });
});
