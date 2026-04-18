// ================================================================
// auth.ts — Middleware de autenticación.
// Acepta la key en header X-API-Key o query param api_key.
// ================================================================
import { Request, Response, NextFunction } from "express";
import { ENV } from "../lib/env.js";

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const key =
    (req.headers["x-api-key"] as string) ??
    (req.query["api_key"] as string) ??
    "";

  // timingSafeEqual para evitar timing attacks (igual al hash_equals del PHP)
  if (!key || !timingSafeEqual(ENV.API_SECRET, key)) {
    res.status(401).json({ error: "No autorizado." });
    return;
  }
  next();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
