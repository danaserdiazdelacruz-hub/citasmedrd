// src/routes/bootstrap.ts
// GET /api/bootstrap — devuelve al dashboard toda su configuración inicial:
//   - Datos del doctor (nombre, id, rol)
//   - Sedes del doctor con sus IDs y nombres
//   - Fecha/hora del servidor en TZ correcta
//
// Tolera que algunas columnas opcionales falten en la base.

import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireUser } from "../middleware/auth.js";
import { ENV } from "../lib/env.js";

export const bootstrapRouter = Router();

// Helper: intenta un select con columnas extras, si falla cae a columnas básicas
async function tryFetchDoctor(doctorId: string): Promise<any | null> {
  // Intentar con columnas opcionales (incluyendo apellido y extension)
  const withExtras = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
    id: `eq.${doctorId}`,
    select: "id,nombre,apellido,extension,especialidad",
    limit: "1",
  });
  if (withExtras.status < 400 && withExtras.data?.[0]) return withExtras.data[0];

  // Fallback: solo columnas garantizadas
  const basic = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
    id: `eq.${doctorId}`,
    select: "id,nombre,apellido",
    limit: "1",
  });
  return basic.data?.[0] ?? null;
}

async function tryFetchSedes(doctorId: string): Promise<any[]> {
  // Intentar con dirección incluida
  const withDir = await supabase<any[]>("GET", "/rest/v1/doctor_clinica", null, {
    doctor_id: `eq.${doctorId}`,
    select: "id,clinicas(id,nombre,ciudad,direccion)",
  });
  if (withDir.status < 400 && Array.isArray(withDir.data)) return withDir.data;

  // Fallback: sin dirección
  const basic = await supabase<any[]>("GET", "/rest/v1/doctor_clinica", null, {
    doctor_id: `eq.${doctorId}`,
    select: "id,clinicas(id,nombre,ciudad)",
  });
  return Array.isArray(basic.data) ? basic.data : [];
}

bootstrapRouter.get("/", requireUser, async (req, res) => {
  const user = req.user!;
  const doctorId = user.doctor_id;

  if (!doctorId) {
    res.status(400).json({ error: "Usuario sin doctor_id asociado" });
    return;
  }

  const doctor = await tryFetchDoctor(doctorId);
  if (!doctor) {
    res.status(404).json({ error: "Doctor no encontrado" });
    return;
  }

  const sedesRaw = await tryFetchSedes(doctorId);
  const sedes = sedesRaw.map((row: any) => ({
    id: row.id,
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
      apellido: doctor.apellido ?? null,
      extension: doctor.extension ?? null,
      especialidad: doctor.especialidad ?? null,
    },
    sedes,
    server: {
      timezone: ENV.TIMEZONE,
      now: new Date().toISOString(),
    },
  });
});
