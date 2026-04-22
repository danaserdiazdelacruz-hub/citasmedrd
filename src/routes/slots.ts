// GET /api/slots?doctor_clinica_id=UUID&fecha=YYYY-MM-DD&servicio_id=UUID
import { Router } from "express";
import { z } from "zod";
import { supabase, rpc } from "../lib/supabase.js";
import { isValidUUID, isValidDate, toLocalTime } from "../lib/dates.js";
import { ENV as envConfig } from "../lib/env.js";

export const slotsRouter = Router();

const QuerySchema = z.object({
  doctor_clinica_id: z.string().refine(isValidUUID, "UUID inválido"),
  fecha: z.string().refine(isValidDate, "Formato: YYYY-MM-DD"),
  servicio_id: z.string().refine(isValidUUID, {
    message: "servicio_id requerido. Primero llama a /api/servicios",
  }),
});

slotsRouter.get("/", async (req, res) => {
  const q = QuerySchema.parse(req.query);
  const { doctor_clinica_id: dcId, fecha, servicio_id: srvId } = q;

  if (fecha < new Date().toLocaleDateString("en-CA")) {
    res.status(400).json({ error: "No se puede consultar fechas pasadas." });
    return;
  }

  // ¿Día bloqueado?
  const bloq = await supabase<any[]>("GET", "/rest/v1/dias_bloqueados", null, {
    doctor_clinica_id: `eq.${dcId}`,
    fecha: `eq.${fecha}`,
    select: "motivo",
    limit: "1",
  });
  if (bloq.data?.[0]) {
    res.json({
      disponible: false,
      fecha,
      motivo: `Día bloqueado: ${bloq.data[0].motivo}`,
      total: 0,
      slots: [],
    });
    return;
  }

  const result = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: dcId,
    p_fecha: fecha,
    p_servicio_id: srvId,
  });

  if (result.status !== 200) {
    res.status(502).json({ error: "Error al obtener disponibilidad." });
    return;
  }

  const slots = (result.data ?? []).map((s: any) => ({
    inicia_en:   s.inicia_en,
    termina_en:  s.termina_en,
    hora_inicio: toLocalTime(s.inicia_en),
    hora_fin:    toLocalTime(s.termina_en),
    hora_24h:    new Date(s.inicia_en).toLocaleTimeString("en-GB", {
      timeZone: envConfig.TIMEZONE, hour: "2-digit", minute: "2-digit",
    }),
  }));

  res.json({
    disponible: slots.length > 0,
    doctor_clinica_id: dcId,
    servicio_id: srvId,
    fecha,
    total: slots.length,
    slots,
  });
});
