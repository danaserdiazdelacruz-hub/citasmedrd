// src/middleware/requestLogger.ts
// Logging estructurado de cada request (sin dependencia pino).
// Imprime JSON por línea para que Railway lo parsee fácilmente.

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const reqId = (req.headers["x-request-id"] as string) || randomUUID().slice(0, 8);

  // Attachar id a la respuesta para debug
  res.setHeader("X-Request-Id", reqId);
  (req as any).reqId = reqId;

  // Cuando termine la respuesta, loggear
  res.on("finish", () => {
    const duration = Date.now() - start;
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim()
      || req.socket.remoteAddress
      || "unknown";

    const logEntry = {
      t: new Date().toISOString(),
      id: reqId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: duration,
      ip: ip.replace(/^::ffff:/, ""), // quita prefijo IPv6-mapped
      ua: (req.headers["user-agent"] || "").substring(0, 80),
    };

    // Errores y respuestas lentas resaltadas
    if (res.statusCode >= 500) {
      console.error(`[REQ-ERROR] ${JSON.stringify(logEntry)}`);
    } else if (res.statusCode >= 400) {
      console.warn(`[REQ-WARN] ${JSON.stringify(logEntry)}`);
    } else if (duration > 3000) {
      console.warn(`[REQ-SLOW] ${JSON.stringify(logEntry)}`);
    } else {
      // 200s normales: una sola línea compacta
      console.log(`[REQ] ${req.method} ${req.path} ${res.statusCode} ${duration}ms id=${reqId}`);
    }
  });

  next();
}
