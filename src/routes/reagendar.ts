// POST /api/reagendar
import { Router } from "express";
import { z } from "zod";
import { rpc } from "../lib/supabase.js";
import { isValidUUID, parseInicia, toLocalTime } from "../lib/dates.js";

export const reagendarRouter = Router();

const BodySchema = z.object({
  cita_id:         z.string().refine(isValidUUID, "UUID inválido"),
  nuevo_inicia_en: z.string().min(1, "Requerido"),
  reagendado_por:  z.string().optional().nullable(),
});

reagendarRouter.post("/", async (req, res) => {
  const data = BodySchema.parse(req.body);
  const { utc: nuevoUtc, localDt } = parseInicia(data.nuevo_inicia_en);

  if (localDt <= new Date()) {
    res.status(400).json({ error: "No se puede reagendar a una fecha/hora en el pasado." });
    return;
  }

  const result = await rpc<any>("fn_reagendar_cita", {
    p_cita_id:         data.cita_id,
    p_nuevo_inicia_en: nuevoUtc,
    p_reagendado_por:  data.reagendado_por ?? null,
  });

  if (result.status !== 200 || !result.data?.[0]) {
    res.status(502).json({ error: "Error de comunicación con la base de datos." });
    return;
  }

  const r = result.data[0];
  if (!r.exito) {
    res.status(409).json({ exito: false, mensaje: r.mensaje });
    return;
  }

  res.json({
    exito:       true,
    cita_id:     r.cita_id,
    codigo:      r.codigo,
    termina_en:  r.termina_en,
    hora_inicio: toLocalTime(nuevoUtc),
    hora_fin:    toLocalTime(r.termina_en),
    mensaje:     r.mensaje,
  });
});
