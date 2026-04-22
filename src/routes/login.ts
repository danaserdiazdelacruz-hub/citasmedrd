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
  try {
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
      console.error("[login] Variables de entorno faltantes:");
      console.error(`  DASHBOARD_EMAIL: ${expectedEmail ? "SET (len=" + expectedEmail.length + ")" : "MISSING"}`);
      console.error(`  DASHBOARD_PASSWORD_HASH: ${expectedHash ? "SET (len=" + expectedHash.length + ")" : "MISSING"}`);
      console.error(`  DASHBOARD_DOCTOR_ID: ${doctorId ? "SET (len=" + doctorId.length + ")" : "MISSING"}`);
      console.error(`  DASHBOARD_DOCTOR_NOMBRE: ${process.env.DASHBOARD_DOCTOR_NOMBRE ? "SET" : "MISSING"}`);
      console.error(`  JWT_SECRET: ${process.env.JWT_SECRET ? "SET" : "MISSING"}`);
      res.status(500).json({ error: "Servidor no configurado" });
      return;
    }

    console.log(`[login] intento de login — email=${email}, hash len=${expectedHash.length}, docId len=${doctorId.length}`);

    // Validar credenciales (timing-safe)
    const emailMatch = timingSafeEqual(email.toLowerCase(), expectedEmail.toLowerCase());
    const passMatch = timingSafeEqual(sha256Hex(password), expectedHash.toLowerCase());

    console.log(`[login] emailMatch=${emailMatch}, passMatch=${passMatch}`);

    if (!emailMatch || !passMatch) {
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
  } catch (err: any) {
    console.error("[login] EXCEPCIÓN:", err.message, err.stack);
    res.status(500).json({ error: "server_error", detail: err.message });
  }
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

// Endpoint TEMPORAL de diagnóstico — retirar después de verificar
// No expone valores, solo si están definidos y su longitud
loginRouter.get("/diag", (_req, res) => {
  res.json({
    DASHBOARD_EMAIL: process.env.DASHBOARD_EMAIL ? `SET len=${process.env.DASHBOARD_EMAIL.length}` : "MISSING",
    DASHBOARD_PASSWORD_HASH: process.env.DASHBOARD_PASSWORD_HASH ? `SET len=${process.env.DASHBOARD_PASSWORD_HASH.length}` : "MISSING",
    DASHBOARD_DOCTOR_ID: process.env.DASHBOARD_DOCTOR_ID ? `SET len=${process.env.DASHBOARD_DOCTOR_ID.length}` : "MISSING",
    DASHBOARD_DOCTOR_NOMBRE: process.env.DASHBOARD_DOCTOR_NOMBRE ? `SET len=${process.env.DASHBOARD_DOCTOR_NOMBRE.length}` : "MISSING",
    JWT_SECRET: process.env.JWT_SECRET ? `SET len=${process.env.JWT_SECRET.length}` : "MISSING",
    API_SECRET: process.env.API_SECRET ? `SET len=${process.env.API_SECRET.length}` : "MISSING",
    NODE_ENV: process.env.NODE_ENV || "undefined",
    hostname: process.env.RAILWAY_PUBLIC_DOMAIN || "unknown",
  });
});
