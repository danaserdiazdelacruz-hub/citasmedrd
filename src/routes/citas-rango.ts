// GET /api/citas-rango?dc_id=UUID&desde=YYYY-MM-DD&hasta=YYYY-MM-DD
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { isValidUUID, isValidDate, toLocalTime, toLocalDate } from "../lib/dates.js";

export const citasRangoRouter = Router();

const SELECT_CITAS = [
  "id","codigo","inicia_en","termina_en",
  "motivo","estado","canal","slots_ocupados",
  "pacientes(nombre,apellido,telefono)",
  "servicios(nombre,duracion_min)",
].join(",");

citasRangoRouter.get("/", async (req, res) => {
  const hoy = new Date().toLocaleDateString("en-CA");
  const q = z.object({
    dc_id: z.string().refine(isValidUUID, "dc_id inválido"),
    desde: z.string().refine(isValidDate, "desde inválida").default(hoy),
    hasta: z.string().refine(isValidDate, "hasta inválida")
           .default(new Date(Date.now() + 7 * 86400000).toLocaleDateString("en-CA")),
  }).parse(req.query);

  if (q.hasta < q.desde) {
    res.status(400).json({ error: "hasta debe ser >= desde." });
    return;
  }

  const diff = Math.round(
    (new Date(q.hasta).getTime() - new Date(q.desde).getTime()) / 86400000
  );
  if (diff > 31) {
    res.status(400).json({ error: "Rango máximo: 31 días." });
    return;
  }

  // Convertir a UTC para filtrar en Supabase
  const desdeUtc = new Date(`${q.desde}T00:00:00`).toISOString();
  const hastaUtc = new Date(`${q.hasta}T23:59:59`).toISOString();

  const result = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    doctor_clinica_id: `eq.${q.dc_id}`,
    select:            SELECT_CITAS,
    order:             "inicia_en.asc",
    limit:             "500",
    and:               `(inicia_en.gte.${desdeUtc},inicia_en.lt.${hastaUtc})`,
  });

  // Agrupar por fecha local
  const dias: Record<string, any[]> = {};
  for (const c of result.data ?? []) {
    const fechaLocal = toLocalDate(c.inicia_en);
    if (!dias[fechaLocal]) dias[fechaLocal] = [];
    const pac = c.pacientes;
    const srv = c.servicios;
    const dur = srv?.duracion_min ?? 30;
    dias[fechaLocal].push({
      id:                c.id,
      codigo:            c.codigo,
      inicia_en:         c.inicia_en,
      termina_en:        c.termina_en,
      hora_inicio:       toLocalTime(c.inicia_en),
      hora_fin:          toLocalTime(c.termina_en),
      estado:            c.estado,
      canal:             c.canal,
      motivo:            c.motivo,
      paciente_nombre:   pac ? `${pac.nombre} ${pac.apellido}` : "N/A",
      paciente_telefono: pac?.telefono ?? "",
      servicio:          srv?.nombre ?? "Consulta",
      duracion_min:      dur,
      duracion_texto:    `${dur} min`,
    });
  }

  const totalCitas = Object.values(dias).reduce((a, b) => a + b.length, 0);

  res.json({
    desde:       q.desde,
    hasta:       q.hasta,
    total_dias:  Object.keys(dias).length,
    total_citas: totalCitas,
    dias,
  });
});
