// GET /api/servicios?doctor_clinica_id=UUID&incluir_admin=true
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { isValidUUID } from "../lib/dates.js";

export const serviciosRouter = Router();

const QuerySchema = z.object({
  doctor_clinica_id: z.string().refine(isValidUUID, "UUID inválido"),
  incluir_admin: z.enum(["true", "false"]).optional().default("false"),
});

serviciosRouter.get("/", async (req, res) => {
  const q = QuerySchema.parse(req.query);
  const dcId = q.doctor_clinica_id;
  const incluirAdmin = q.incluir_admin === "true";

  const srvParams: Record<string, string> = {
    doctor_clinica_id: `eq.${dcId}`,
    activo: "eq.true",
    select: "id,nombre,duracion_min,buffer_min,tipo,precio,invisible_para_pacientes",
    order: "duracion_min.asc",
  };
  if (!incluirAdmin) srvParams["invisible_para_pacientes"] = "eq.false";

  const [srvRes, dcRes] = await Promise.all([
    supabase<any[]>("GET", "/rest/v1/servicios", null, srvParams),
    supabase<any[]>("GET", "/rest/v1/doctor_clinica", null, {
      id: `eq.${dcId}`,
      activo: "eq.true",
      select: "doctores(nombre,apellido),clinicas(nombre,direccion,ciudad,timezone)",
      limit: "1",
    }),
  ]);

  if (!dcRes.data?.[0]) {
    res.status(404).json({ error: "Consultorio no encontrado o inactivo." });
    return;
  }

  const doc = dcRes.data[0].doctores;
  const cli = dcRes.data[0].clinicas;

  const servicios = (srvRes.data ?? []).map((s: any) => ({
    id: s.id,
    nombre: s.nombre,
    duracion_min: s.duracion_min,
    buffer_min: s.buffer_min,
    tipo: s.tipo,
    duracion_texto: `${s.duracion_min} minutos`,
    precio_texto: s.precio
      ? `RD$${Number(s.precio).toLocaleString("es-DO", { maximumFractionDigits: 0 })}`
      : "Consultar",
    ...(incluirAdmin ? { invisible_para_pacientes: s.invisible_para_pacientes } : {}),
  }));

  res.json({
    doctor_clinica_id: dcId,
    doctor: { nombre_completo: `Dr. ${doc.nombre} ${doc.apellido}` },
    clinica: { nombre: cli.nombre, direccion: cli.direccion, ciudad: cli.ciudad },
    servicios,
    total: servicios.length,
  });
});
