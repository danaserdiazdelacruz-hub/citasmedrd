// src/index.ts
// Entry point temporal. Solo valida env y arranca un server mínimo para que
// Railway no falle el healthcheck. La lógica real llega con el Bloque 3+.

import { ENV } from "./config/env.js";

console.log(`[startup] CitasMed Backend arrancando…`);
console.log(`[startup] env=${ENV.NODE_ENV} port=${ENV.PORT} model=${ENV.ANTHROPIC_MODEL}`);

// Server HTTP mínimo (sin Fastify aún — lo montamos en Bloque 3)
// Solo para responder al healthcheck de Railway y verificar que el proceso corre.
import { createServer } from "node:http";

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      env: ENV.NODE_ENV,
      timestamp: new Date().toISOString(),
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(ENV.PORT, () => {
  console.log(`[startup] HTTP listo en :${ENV.PORT}`);
  console.log(`[startup] Bloque 1+2 activos (config + domain). Siguiente: Bloque 3 (persistence).`);
});

// Graceful shutdown para Railway
const shutdown = (signal: string) => {
  console.log(`[shutdown] señal recibida: ${signal}`);
  server.close(() => {
    console.log(`[shutdown] server cerrado`);
    process.exit(0);
  });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
