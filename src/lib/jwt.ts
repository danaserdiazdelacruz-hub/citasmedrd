// src/lib/jwt.ts
// Helper mínimo de JWT HS256 sin dependencias externas.
// Para uso interno del dashboard — no firma tokens para terceros.

import crypto from "crypto";
import { ENV } from "./env.js";

// Obtiene el secreto de JWT (si no hay, usa API_SECRET como fallback)
function getSecret(): string {
  return process.env.JWT_SECRET || ENV.API_SECRET;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(input: string): Buffer {
  const pad = 4 - (input.length % 4);
  const padded = input + (pad < 4 ? "=".repeat(pad) : "");
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface JWTPayload {
  sub: string;          // user id
  email?: string;
  rol: string;          // 'doctor' | 'super_admin' | 'secretaria'
  doctor_id?: string;
  nombre?: string;
  iat: number;
  exp: number;
}

/** Firma un token JWT HS256. */
export function signJWT(payload: Omit<JWTPayload, "iat" | "exp">, expiresInSec: number = 8 * 3600): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JWTPayload = { ...payload, iat: now, exp: now + expiresInSec };

  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(fullPayload));
  const data = `${h}.${p}`;

  const sig = crypto.createHmac("sha256", getSecret()).update(data).digest();
  return `${data}.${base64url(sig)}`;
}

/** Verifica y decodifica un JWT. Lanza Error si es inválido o expiró. */
export function verifyJWT(token: string): JWTPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Token malformado");

  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  const expected = base64url(crypto.createHmac("sha256", getSecret()).update(data).digest());

  // Comparación constante
  if (s.length !== expected.length) throw new Error("Firma inválida");
  let diff = 0;
  for (let i = 0; i < s.length; i++) diff |= s.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) throw new Error("Firma inválida");

  const payload = JSON.parse(base64urlDecode(p).toString("utf8")) as JWTPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Token expirado");

  return payload;
}
