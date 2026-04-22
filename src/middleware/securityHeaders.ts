// src/middleware/securityHeaders.ts
// Headers de seguridad sin dependencia helmet.
// Cubre los headers más importantes.

import type { Request, Response, NextFunction } from "express";

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  // Prevenir MIME sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Prevenir clickjacking (nuestro dashboard no necesita ser embebido)
  res.setHeader("X-Frame-Options", "DENY");

  // XSS protection (navegadores antiguos)
  res.setHeader("X-XSS-Protection", "1; mode=block");

  // Referrer minimal
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // HSTS: obliga HTTPS (1 año). Railway ya sirve HTTPS.
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

  // Permissions policy: desactivar APIs que no usamos
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

  // Ocultar que es Express
  res.removeHeader("X-Powered-By");

  next();
}
