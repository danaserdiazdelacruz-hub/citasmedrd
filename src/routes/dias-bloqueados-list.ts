// GET /api/dias-bloqueados?dc_id=UUID
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { isValidUUID } from "../lib/dates.js";

export const diasBloqueadosRouter = Router();

diasBloqueadosRouter.get("/", async (req, res) => {
  const q = z.object({
    dc_id: z.string().refine(isValidUUID, "dc_id inválido"),
  }).parse(req.query);

  const hoy = new Date().toLocaleDateString("en-CA");

  const result = await supabase<any[]>("GET", "/rest/v1/dias_bloqueados", null, {
    doctor_clinica_id: `eq.${q.dc_id}`,
    fecha:             `gte.${hoy}`,
    select:            "fecha,motivo",
    order:             "fecha.asc",
    limit:             "20",
  });

  res.json({ dias: result.data ?? [] });
});
