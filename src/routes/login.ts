// src/routes/login.ts
// POST /api/login — Autenticación multi-doctor contra Supabase.
//
// La tabla `usuarios` tiene: id, email, password_hash (sha256), doctor_id, rol, nombre
// Cada doctor tiene su propio email + contraseña. Un doctor puede tener múltiples sedes.

import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { signJWT } from "../lib/jwt.js";
import { supabase } from "../lib/supabase.js";

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

loginRouter.post("/", async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Email o contraseña inválidos" });
      return;
    }
    const { email, password } = parsed.data;

    // Buscar usuario en Supabase por email
    const r = await supabase<any[]>("GET", "/rest/v1/usuarios", null, {
      email: `eq.${email.toLowerCase()}`,
      activo: "eq.true",
      select: "id,email,password_hash,doctor_id,rol,nombre",
      limit: "1",
    });

    const user = r.data?.[0];

    // Siempre calcular hash y comparar (evita timing attack aunque no exista el usuario)
    const inputHash = sha256Hex(password);
    const storedHash = user?.password_hash || "0".repeat(64);
    const passOk = timingSafeEqual(inputHash, storedHash.toLowerCase());

    if (!user || !passOk) {
      // Delay de 1s para dificultar brute force
      await new Promise(r => setTimeout(r, 1000));
      res.status(401).json({ error: "Credenciales incorrectas" });
      return;
    }

    if (!user.doctor_id) {
      res.status(403).json({ error: "Este usuario no tiene un doctor asociado" });
      return;
    }

    // JWT válido 8 horas
    const token = signJWT({
      sub: user.id,
      email: user.email,
      rol: user.rol || "doctor",
      doctor_id: user.doctor_id,
      nombre: user.nombre,
    }, 8 * 3600);

    // Actualizar último acceso (fire & forget, no bloquea respuesta)
    supabase("PATCH", `/rest/v1/usuarios?id=eq.${user.id}`, {
      ultimo_acceso: new Date().toISOString(),
    }).catch(() => {});

    res.json({
      token,
      expiresIn: 8 * 3600,
      user: {
        email: user.email,
        rol: user.rol || "doctor",
        doctor_id: user.doctor_id,
        nombre: user.nombre,
      },
    });
  } catch (err: any) {
    console.error("[login] ERROR:", err.message);
    res.status(500).json({ error: "server_error" });
  }
});

// Verificar token activo
loginRouter.get("/me", (req, res) => {
  const user = (req as any).user;
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  res.json({ user });
});
