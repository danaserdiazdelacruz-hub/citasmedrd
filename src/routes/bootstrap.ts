// src/routes/bootstrap.ts
// GET /api/bootstrap — devuelve al dashboard toda su configuración inicial:
//   - Datos del doctor (nombre, id, rol)
//   - Sedes del doctor con sus IDs y nombres
//   - Fecha/hora del servidor en TZ correcta
//
// Esto reemplaza los valores hardcoded en el HTML (SEDES[], DC_ID, nombre doctor).

import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireUser } from "../middleware/auth.js";
import { ENV } from "../lib/env.js";

export const bootstrapRouter = Router();

bootstrapRouter.get("/", requireUser, async (req, res) => {
  const user = req.user!;
  const doctorId = user.doctor_id;

  if (!doctorId) {
    res.status(400).json({ error: "Usuario sin doctor_id asociado" });
    return;
  }

  // Traer doctor
  const docResp = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
    id: `eq.${doctorId}`,
    select: "id,nombre,extension,especialidad",
    limit: "1",
  });
  const doctor = docResp.data?.[0];

  if (!doctor) {
    res.status(404).json({ error: "Doctor no encontrado" });
    return;
  }

  // Traer sedes del doctor
  const dcResp = await supabase<any[]>("GET", "/rest/v1/doctor_clinica", null, {
    doctor_id: `eq.${doctorId}`,
    activo: "eq.true",
    select: "id,clinicas(id,nombre,ciudad,direccion)",
  });

  const sedes = (dcResp.data || []).map((row: any) => ({
    id: row.id,             // doctor_clinica_id (el que usa el dashboard)
    clinica_id: row.clinicas?.id,
    nombre: row.clinicas?.nombre || "Sede",
    ciudad: row.clinicas?.ciudad || "",
    direccion: row.clinicas?.direccion || "",
  }));

  res.json({
    user: {
      email: user.email,
      rol: user.rol,
      nombre: user.nombre || doctor.nombre,
    },
    doctor: {
      id: doctor.id,
      nombre: doctor.nombre,
      extension: doctor.extension,
      especialidad: doctor.especialidad,
    },
    sedes,
    server: {
      timezone: ENV.TIMEZONE,
      now: new Date().toISOString(),
    },
  });
});
