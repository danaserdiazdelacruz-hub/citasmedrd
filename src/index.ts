// src/index.ts
// Entry point. HTTP server con:
//   GET  /health           → status + DB check
//   POST /webhook/telegram → recibe updates de Telegram

import { ENV } from "./config/env.js";
import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from "node:http";
import { getDb } from "./persistence/db.js";
import { handleTelegramUpdate } from "./channels/telegram/webhook.js";

console.log(`[startup] CitasMed Backend arrancando…`);
console.log(`[startup] env=${ENV.NODE_ENV} port=${ENV.PORT} model=${ENV.ANTHROPIC_MODEL}`);

async function smokeTestDb(): Promise<void> {
  try {
    const db = getDb();
    const { error } = await db.from("tipos_profesional").select("id").limit(1);
    if (error) console.error(`[startup] ⚠️  DB smoke test falló: ${error.message}`);
    else console.log(`[startup] ✓ DB conectada (Supabase)`);
  } catch (err) {
    console.error(`[startup] ⚠️  DB smoke test exception:`, err);
  }
}

async function readBody(req: HttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function respond(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // Health
  if ((url === "/health" || url === "/") && method === "GET") {
    let dbStatus: "ok" | "fail" = "ok";
    try {
      const db = getDb();
      const { error } = await db.from("tipos_profesional").select("id").limit(1);
      if (error) dbStatus = "fail";
    } catch {
      dbStatus = "fail";
    }
    respond(res, 200, {
      status: "ok",
      env: ENV.NODE_ENV,
      db: dbStatus,
      model: ENV.ANTHROPIC_MODEL,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Telegram webhook
  if (url.startsWith("/webhook/telegram") && method === "POST") {
    try {
      const bodyText = await readBody(req);
      const update = JSON.parse(bodyText);
      console.log(`[telegram] update recibido: id=${update.update_id}`);

      // Telegram exige que respondamos rápido (timeout ~5s).
      // Enviamos 200 inmediato, procesamos en background.
      respond(res, 200, { ok: true });

      handleTelegramUpdate(update).catch(err => {
        console.error(`[telegram] error procesando update ${update.update_id}:`, err);
      });
      return;
    } catch (err) {
      console.error(`[telegram] error parseando body:`, err);
      respond(res, 400, { error: "invalid body" });
      return;
    }
  }

  respond(res, 404, { error: "not found" });
});

const HOST = "0.0.0.0";
server.listen(ENV.PORT, HOST, async () => {
  console.log(`[startup] HTTP listo en ${HOST}:${ENV.PORT}`);
  console.log(`[startup] Healthcheck: /health`);
  console.log(`[startup] Webhook Telegram: /webhook/telegram`);
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
  // NO matamos el proceso — solo loggeamos. Evita que un rejection
  // en el procesamiento de un webhook de Telegram tumbe el servidor.
  console.error(`[warn] unhandledRejection (no fatal):`, reason);
});
