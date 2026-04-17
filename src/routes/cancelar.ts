// POST /api/cancelar
import { Router } from "express";
import { z } from "zod";
import { supabase, rpc } from "../lib/supabase.js";
import { isValidUUID } from "../lib/dates.js";

export const cancelarRouter = Router();

const MOTIVOS = ["cancelada_paciente","cancelada_doctor","cancelada_clinica","no_show"] as const;

const BodySchema = z.object({
  cita_id:       z.string().refine(isValidUUID).optional(),
  codigo:        z.string().optional(),
  motivo_cancel: z.enum(MOTIVOS).default("cancelada_paciente"),
  cancelado_por: z.string().optional().nullable(),
}).refine(d => d.cita_id || d.codigo, {
  message: "Se requiere cita_id o codigo.",
});

cancelarRouter.post("/", async (req, res) => {
  const data = BodySchema.parse(req.body);
  let citaId = data.cita_id;

  // Resolver cita_id desde código
  if (!citaId && data.codigo) {
    let codigo = data.codigo.toUpperCase().trim();
    if (!codigo.startsWith("CITA-")) codigo = "CITA-" + codigo;

    const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
      codigo: `eq.${codigo}`,
      select: "id,estado",
      limit:  "1",
    });
    if (!found.data?.[0]?.id) {
      res.status(404).json({ error: `No se encontró cita con código: ${codigo}` });
      return;
    }
    const estado = found.data[0].estado;
    if (!["pendiente","confirmada"].includes(estado)) {
      res.status(409).json({
        exito: false,
        mensaje: `La cita ya está en estado '${estado}' y no puede cancelarse.`,
      });
      return;
    }
    citaId = found.data[0].id;
  }

  const result = await rpc<any>("fn_cancelar_cita", {
    p_cita_id:            citaId,
    p_motivo_cancel:      data.motivo_cancel,
    p_cancelado_por:      data.cancelado_por ?? null,
    p_penalizar_paciente: null,
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

  // Leer reactivable_hasta
  const info = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    id: `eq.${citaId}`, select: "reactivable_hasta", limit: "1",
  });

  res.json({
    exito:             true,
    cita_id:           citaId,
    mensaje:           r.mensaje,
    reactivable_hasta: info.data?.[0]?.reactivable_hasta ?? null,
    puede_deshacer:    !!info.data?.[0]?.reactivable_hasta,
  });
});
