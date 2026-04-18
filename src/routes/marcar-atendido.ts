// POST /api/marcar-atendido
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { isValidUUID } from "../lib/dates.js";

export const marcarAtendidoRouter = Router();

const BodySchema = z.object({
  cita_id: z.string().refine(isValidUUID, "UUID inválido"),
});

marcarAtendidoRouter.post("/", async (req, res) => {
  const { cita_id } = BodySchema.parse(req.body);

  // Verificar estado actual
  const cita = await supabase<any[]>("GET", "/rest/v1/citas", null, {
    id:     `eq.${cita_id}`,
    select: "id,estado,paciente_id,doctor_clinica_id",
    limit:  "1",
  });
  if (!cita.data?.[0]) {
    res.status(404).json({ error: "Cita no encontrada." });
    return;
  }

  const { estado, paciente_id, doctor_clinica_id } = cita.data[0];
  if (!["pendiente","confirmada"].includes(estado)) {
    res.status(409).json({ error: `No se puede completar una cita en estado '${estado}'.` });
    return;
  }

  // Marcar como completada
  await supabase("PATCH", "/rest/v1/citas", { estado: "completada" },
    { id: `eq.${cita_id}` },
    { "Prefer": "return=minimal" },
  );

  // Actualizar total_visitas del paciente con el doctor
  const dcRes = await supabase<any[]>("GET", "/rest/v1/doctor_clinica", null, {
    id: `eq.${doctor_clinica_id}`, select: "doctor_id", limit: "1",
  });
  const doctorId = dcRes.data?.[0]?.doctor_id;

  if (doctorId) {
    await supabase(
      "POST", "/rest/v1/doctor_paciente",
      { doctor_id: doctorId, paciente_id, total_visitas: 1 },
      {},
      { "Prefer": "resolution=merge-duplicates,return=minimal" },
    );
  }

  res.json({ exito: true, mensaje: "Cita marcada como completada." });
});
