// src/index.ts
// Entry point temporal. Solo valida env y arranca un server mínimo para que
// Railway no falle el healthcheck. La lógica real llega con el Bloque 3+.

// IMPORTANTE: los imports van PRIMERO, siempre.
import { ENV } from "./config/env.js";
import { createServer } from "node:http";

console.log(`[startup] CitasMed Backend arrancando…`);
console.log(`[startup] env=${ENV.NODE_ENV} port=${ENV.PORT} model=${ENV.ANTHROPIC_MODEL}`);

const server = createServer((req, res) => {
  // Health endpoint
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      env: ENV.NODE_ENV,
      timestamp: new Date().toISOString(),
    }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// CRÍTICO: escuchar en 0.0.0.0, no en localhost.
// Railway (y cualquier contenedor) necesita 0.0.0.0 para que el tráfico externo llegue.
const HOST = "0.0.0.0";
server.listen(ENV.PORT, HOST, () => {
  console.log(`[startup] HTTP listo en ${HOST}:${ENV.PORT}`);
  console.log(`[startup] Healthcheck: /health`);
});

server.on("error", (err) => {
  console.error(`[startup] error en servidor:`, err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = (signal: string) => {
  console.log(`[shutdown] señal recibida: ${signal}`);
  server.close(() => {
    console.log(`[shutdown] server cerrado`);
    process.exit(0);
  });
  // Timeout de seguridad: si no cierra en 10s, matar forzado
  setTimeout(() => {
    console.error(`[shutdown] timeout, forzando exit`);
    process.exit(1);
  }, 10000);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Captura de errores no manejados — en Railway aparecen en logs
process.on("uncaughtException", (err) => {
  console.error(`[fatal] uncaughtException:`, err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[fatal] unhandledRejection:`, reason);
  process.exit(1);
});
