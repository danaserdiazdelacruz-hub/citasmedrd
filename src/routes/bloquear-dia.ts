// POST /api/bloquear-dia  → bloquear
// DELETE /api/bloquear-dia → desbloquear
import { Router } from "express";
import { z } from "zod";
import { supabase, rpc } from "../lib/supabase.js";
import { isValidUUID, isValidDate } from "../lib/dates.js";

export const bloquearDiaRouter = Router();

const BodySchema = z.object({
  doctor_clinica_id: z.string().refine(isValidUUID, "UUID inválido"),
  fecha:             z.string().refine(isValidDate, "Formato: YYYY-MM-DD"),
  motivo:            z.string().optional().default("Día bloqueado"),
});

// BLOQUEAR
bloquearDiaRouter.post("/", async (req, res) => {
  const data = BodySchema.parse(req.body);
  const { doctor_clinica_id: dcId, fecha, motivo } = data;

  const hoy = new Date().toLocaleDateString("en-CA");
  if (fecha < hoy) {
    res.status(400).json({ error: "No se puede bloquear una fecha pasada." });
    return;
  }

  const result = await supabase(
    "POST", "/rest/v1/dias_bloqueados",
    { doctor_clinica_id: dcId, fecha, motivo },
    {},
    { "Prefer": "return=representation,resolution=ignore-duplicates" },
    [409],
  );

  if (result.status === 409) {
    res.status(409).json({ error: "Ese día ya está bloqueado.", fecha });
    return;
  }
  if (result.status !== 201) {
    res.status(502).json({ error: "Error al bloquear el día." });
    return;
  }

  // Eliminar slots disponibles (los que tienen cita se mantienen)
  const slotsRes = await supabase<any[]>("GET", "/rest/v1/agenda_slots", null, {
    doctor_clinica_id: `eq.${dcId}`,
    fecha:             `eq.${fecha}`,
    disponible:        "eq.true",
    select:            "id",
  });
  const nSlots = slotsRes.data?.length ?? 0;

  if (nSlots > 0) {
    await supabase("DELETE", "/rest/v1/agenda_slots", null, {
      doctor_clinica_id: `eq.${dcId}`,
      fecha:             `eq.${fecha}`,
      disponible:        "eq.true",
    });
  }

  res.status(201).json({
    exito:           true,
    fecha,
    motivo,
    slots_removidos: nSlots,
    mensaje:         `Día ${fecha} bloqueado. El bot no ofrecerá citas ese día.`,
  });
});

// DESBLOQUEAR
bloquearDiaRouter.delete("/", async (req, res) => {
  // DELETE puede enviar body o query params
  const raw = Object.keys(req.body ?? {}).length > 0 ? req.body : req.query;
  const data = BodySchema.parse(raw);
  const { doctor_clinica_id: dcId, fecha } = data;

  const del = await supabase("DELETE", "/rest/v1/dias_bloqueados", null, {
    doctor_clinica_id: `eq.${dcId}`,
    fecha:             `eq.${fecha}`,
  });

  if (del.status !== 200 && del.status !== 204) {
    res.status(502).json({ error: "Error al desbloquear el día." });
    return;
  }

  // Regenerar slots inmediatamente
  const gen = await rpc<number>("fn_generar_slots", {
    p_doctor_clinica_id: dcId,
    p_fecha_inicio:      fecha,
    p_dias:              1,
  });

  res.json({
    exito:         true,
    fecha,
    slots_creados: gen.data?.[0] ?? 0,
    mensaje:       `Día ${fecha} desbloqueado. Slots generados.`,
  });
});
