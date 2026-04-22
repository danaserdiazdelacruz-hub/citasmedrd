// src/routes/login.ts
// Endpoint POST /api/login — emite JWT para el dashboard.
//
// Credenciales iniciales: se leen de variables de entorno.
// Cuando tengamos Supabase Auth, esto se reemplaza por supabase.auth.signInWithPassword.
//
// Variables de entorno necesarias (Railway):
//   DASHBOARD_EMAIL=doctor@ejemplo.com
//   DASHBOARD_PASSWORD_HASH=<hash sha256 hex de la contraseña>
//   DASHBOARD_DOCTOR_ID=<UUID del doctor>
//   DASHBOARD_DOCTOR_NOMBRE=Dr. Hairol Pérez
//   JWT_SECRET=<string aleatorio de 32+ chars>
//
// Para generar el hash de la contraseña:
//   echo -n "mi_password" | sha256sum

import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { signJWT } from "../lib/jwt.js";

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(4).max(200),
});

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const loginRouter = Router();

loginRouter.post("/", (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Email o contraseña inválidos" });
    return;
  }
  const { email, password } = parsed.data;

  const expectedEmail = process.env.DASHBOARD_EMAIL;
  const expectedHash = process.env.DASHBOARD_PASSWORD_HASH;
  const doctorId = process.env.DASHBOARD_DOCTOR_ID;
  const doctorNombre = process.env.DASHBOARD_DOCTOR_NOMBRE || "Doctor";

  if (!expectedEmail || !expectedHash || !doctorId) {
    console.error("[login] Variables de entorno faltantes: DASHBOARD_EMAIL, DASHBOARD_PASSWORD_HASH, DASHBOARD_DOCTOR_ID");
    res.status(500).json({ error: "Servidor no configurado" });
    return;
  }

  // Validar credenciales (timing-safe)
  const emailMatch = timingSafeEqual(email.toLowerCase(), expectedEmail.toLowerCase());
  const passMatch = timingSafeEqual(sha256Hex(password), expectedHash.toLowerCase());

  if (!emailMatch || !passMatch) {
    // 1 segundo de delay para frenar ataques de fuerza bruta
    setTimeout(() => {
      res.status(401).json({ error: "Credenciales incorrectas" });
    }, 1000);
    return;
  }

  // Emitir JWT válido 8 horas
  const token = signJWT({
    sub: doctorId,
    email: expectedEmail,
    rol: "doctor",
    doctor_id: doctorId,
    nombre: doctorNombre,
  }, 8 * 3600);

  res.json({
    token,
    expiresIn: 8 * 3600,
    user: {
      email: expectedEmail,
      rol: "doctor",
      doctor_id: doctorId,
      nombre: doctorNombre,
    },
  });
});

// Endpoint para que el dashboard verifique si su token sigue válido
loginRouter.get("/me", (_req, res) => {
  // El middleware authenticate ya validó el token y puso user en req.user
  const user = (_req as any).user;
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  res.json({ user });
});
