// GET /api/citas-dia?dc_id=UUID&fecha=YYYY-MM-DD
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { isValidUUID, isValidDate, toLocalTime, toLocalDate } from "../lib/dates.js";

export const citasDiaRouter = Router();

const SELECT_CITAS = [
  "id","codigo","inicia_en","termina_en",
  "motivo","estado","canal","slots_ocupados",
  "pacientes(nombre,apellido,telefono)",
  "servicios(nombre,duracion_min)",
].join(",");

function mapCita(c: any, fecha: string) {
  const pac = c.pacientes;
  const srv = c.servicios;
  const dur = srv?.duracion_min ?? 30;
  return {
    id:                 c.id,
    codigo:             c.codigo,
    inicia_en:          c.inicia_en,
    termina_en:         c.termina_en,
    hora_inicio:        toLocalTime(c.inicia_en),
    hora_fin:           toLocalTime(c.termina_en),
    estado:             c.estado,
    canal:              c.canal,
    motivo:             c.motivo,
    paciente_nombre:    pac ? `${pac.nombre} ${pac.apellido}` : "N/A",
    paciente_telefono:  pac?.telefono ?? "",
    servicio:           srv?.nombre ?? "Consulta",
    duracion_min:       dur,
    duracion_texto:     `${dur} min`,
  };
}

citasDiaRouter.get("/", async (req, res) => {
  const q = z.object({
    dc_id: z.string().refine(isValidUUID, "dc_id inválido"),
    fecha: z.string().refine(isValidDate, "fecha inválida").optional()
           .default(new Date().toLocaleDateString("en-CA")),
  }).parse(req.query);

  const result = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    doctor_clinica_id: `eq.${q.dc_id}`,
    select:            SELECT_CITAS,
    order:             "inicia_en.asc",
  });

  // Filtrar por fecha local (las citas vienen en UTC)
  const citas = (result.data ?? [])
    .filter(c => toLocalDate(c.inicia_en) === q.fecha)
    .map(c => mapCita(c, q.fecha));

  res.json({ fecha: q.fecha, total: citas.length, citas });
});
