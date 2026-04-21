// src/middleware/rateLimit.ts
// Rate limiter simple en memoria. Sin dependencia externa.
// Para producción multi-instancia, cambiar a Redis.

import type { Request, Response, NextFunction } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Crea un middleware de rate limiting por IP+ruta.
 * @param opts.windowMs  Ventana de tiempo en ms (default 60000 = 1 min)
 * @param opts.max       Requests máximos por ventana por IP (default 60)
 * @param opts.message   Mensaje cuando se excede (default: "Demasiadas solicitudes")
 */
export function rateLimit(opts: {
  windowMs?: number;
  max?: number;
  message?: string;
} = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 60;
  const message = opts.message ?? "Demasiadas solicitudes. Intente en un minuto.";

  const buckets = new Map<string, Bucket>();

  // Limpieza periódica para que no crezca indefinidamente
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(windowMs, 60_000));

  return function rateLimiter(req: Request, res: Response, next: NextFunction) {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim()
      || req.socket.remoteAddress
      || "unknown";

    const key = `${ip}:${req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;

    // Headers estándar RFC
    res.setHeader("RateLimit-Limit", max);
    res.setHeader("RateLimit-Remaining", Math.max(0, max - bucket.count));
    res.setHeader("RateLimit-Reset", Math.ceil((bucket.resetAt - now) / 1000));

    if (bucket.count > max) {
      console.warn(`[rate-limit] IP ${ip} excedió límite en ${req.path}`);
      res.status(429).json({ error: "rate_limit_exceeded", message });
      return;
    }

    next();
  };
}
