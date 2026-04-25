// src/index.ts
// Entry point. Valida env, conecta DB, arranca server HTTP con healthcheck.

import { ENV } from "./config/env.js";
import { createServer } from "node:http";
import { getDb } from "./persistence/db.js";
import { tenantsRepo } from "./persistence/repositories/index.js";

console.log(`[startup] CitasMed Backend arrancando…`);
console.log(`[startup] env=${ENV.NODE_ENV} port=${ENV.PORT} model=${ENV.ANTHROPIC_MODEL}`);

// Smoke test de DB al arrancar (no bloquea, pero loggea)
async function smokeTestDb(): Promise<void> {
  try {
    const db = getDb();
    const { error } = await db.from("tipos_profesional").select("id").limit(1);
    if (error) {
      console.error(`[startup] ⚠️  DB smoke test falló: ${error.message}`);
    } else {
      console.log(`[startup] ✓ DB conectada (Supabase)`);
    }
  } catch (err) {
    console.error(`[startup] ⚠️  DB smoke test exception:`, err);
  }
}

const server = createServer(async (req, res) => {
  // Health endpoint
  if (req.url === "/health" || req.url === "/") {
    let dbStatus: "ok" | "fail" = "ok";
    try {
      const db = getDb();
      const { error } = await db.from("tipos_profesional").select("id").limit(1);
      if (error) dbStatus = "fail";
    } catch {
      dbStatus = "fail";
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      env: ENV.NODE_ENV,
      db: dbStatus,
      model: ENV.ANTHROPIC_MODEL,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const HOST = "0.0.0.0";
server.listen(ENV.PORT, HOST, async () => {
  console.log(`[startup] HTTP listo en ${HOST}:${ENV.PORT}`);
  console.log(`[startup] Healthcheck: /health`);
  await smokeTestDb();
});

server.on("error", (err) => {
  console.error(`[startup] error en servidor:`, err);
  process.exit(1);
});

const shutdown = (signal: string) => {
  console.log(`[shutdown] señal recibida: ${signal}`);
  server.close(() => {
    console.log(`[shutdown] server cerrado`);
    process.exit(0);
  });
  setTimeout(() => {
    console.error(`[shutdown] timeout, forzando exit`);
    process.exit(1);
  }, 10000);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error(`[fatal] uncaughtException:`, err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[fatal] unhandledRejection:`, reason);
  process.exit(1);
});

// Mark tenantsRepo as used so linter doesn't complain (will be used in next blocks)
void tenantsRepo;
