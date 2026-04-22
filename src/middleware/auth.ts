// src/middleware/auth.ts
// Autenticación dual:
//  - JWT en header "Authorization: Bearer <token>" (dashboard)
//  - API key en header "X-API-Key" o query ?api_key= (bot, herramientas internas)
//
// Si cualquiera es válido, la request pasa. Se prefiere JWT y se pone la info
// del usuario en req.user.

import type { Request, Response, NextFunction } from "express";
import { ENV } from "../lib/env.js";
import { verifyJWT, JWTPayload } from "../lib/jwt.js";

// Extender el tipo Request para llevar el user
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  // 1) Intentar JWT
  const authHeader = req.headers["authorization"] as string | undefined;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    try {
      const payload = verifyJWT(token);
      req.user = payload;
      return next();
    } catch (e: any) {
      // Token inválido, probar API key antes de rechazar
      console.warn(`[auth] JWT inválido: ${e.message}`);
    }
  }

  // 2) Intentar API key
  const apiKey =
    (req.headers["x-api-key"] as string) ??
    (req.query["api_key"] as string) ??
    "";

  if (apiKey && timingSafeEqual(ENV.API_SECRET, apiKey)) {
    // API key válida — sin info de usuario específico, es acceso de servicio
    return next();
  }

  res.status(401).json({ error: "No autorizado" });
}

/**
 * Middleware adicional opcional para rutas que requieren SOLO JWT
 * (es decir, que el usuario sea una persona, no el bot).
 */
export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(403).json({ error: "Se requiere sesión de usuario" });
    return;
  }
  next();
}
