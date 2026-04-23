// ================================================================
// index.ts — Punto de entrada del servidor CitasMed API
// ================================================================
import "express-async-errors";
import express from "express";
import { ENV } from "./lib/env.js";
import { authenticate } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { requestLogger } from "./middleware/requestLogger.js";

// Rutas
import { testRouter }           from "./routes/test.js";
import { serviciosRouter }      from "./routes/servicios.js";
import { slotsRouter }          from "./routes/slots.js";
import { agendarRouter }        from "./routes/agendar.js";
import { cancelarRouter }       from "./routes/cancelar.js";
import { reagendarRouter }      from "./routes/reagendar.js";
import { marcarAtendidoRouter } from "./routes/marcar-atendido.js";
import { citasDiaRouter }       from "./routes/citas-dia.js";
import { citasRangoRouter }     from "./routes/citas-rango.js";
import { proximasRouter }       from "./routes/proximas.js";
import { bloquearDiaRouter }    from "./routes/bloquear-dia.js";
import { diasBloqueadosRouter } from "./routes/dias-bloqueados-list.js";
import { webhookRouter }        from "./routes/webhook.js";
import { loginRouter }          from "./routes/login.js";
import { bootstrapRouter }      from "./routes/bootstrap.js";
import { iniciarRecordatorios } from "./recordatorios/recordatorios.js";

const app = express();

// Express detrás de un proxy (Railway) necesita confiar en X-Forwarded-For
app.set("trust proxy", 1);

// ── Middlewares globales ─────────────────────────────────────
app.use(express.json({ limit: "100kb" })); // limitar payload para prevenir abuso
app.use(securityHeaders);
app.use(requestLogger);

// CORS
app.use((_req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, X-Request-Id, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset");
  res.setHeader("Access-Control-Max-Age", "86400");
  next();
});
app.options("*", (_req, res) => res.status(204).send());

// ── Rate limiting ────────────────────────────────────────────
// Global: 120 req/min por IP en cualquier ruta /api
app.use("/api", rateLimit({ windowMs: 60_000, max: 120 }));

// Restrictivo: 10 req/min por IP en endpoints de escritura
app.use("/api/agendar",         rateLimit({ windowMs: 60_000, max: 10, message: "Demasiados intentos de agendar. Espere un minuto." }));
app.use("/api/cancelar",        rateLimit({ windowMs: 60_000, max: 10 }));
app.use("/api/reagendar",       rateLimit({ windowMs: 60_000, max: 10 }));
app.use("/api/marcar-atendido", rateLimit({ windowMs: 60_000, max: 20 }));
app.use("/api/bloquear-dia",    rateLimit({ windowMs: 60_000, max: 15 }));

// Webhook: más permisivo porque Telegram puede enviar muchos
app.use("/webhook", rateLimit({ windowMs: 60_000, max: 300 }));

// ── Login (NO requiere auth — es el punto de entrada) ───────
// Rate limit estricto para prevenir brute force
app.use("/api/login", rateLimit({ windowMs: 60_000, max: 5, message: "Demasiados intentos. Espere un minuto." }));
app.use("/api/login", loginRouter);

// ── Autenticación ────────────────────────────────────────────
app.use("/api", authenticate);

// ── Rutas ────────────────────────────────────────────────────
app.use("/api/bootstrap",         bootstrapRouter);
app.use("/api/test",              testRouter);
app.use("/api/servicios",         serviciosRouter);
app.use("/api/slots",             slotsRouter);
app.use("/api/agendar",           agendarRouter);
app.use("/api/cancelar",          cancelarRouter);
app.use("/api/reagendar",         reagendarRouter);
app.use("/api/marcar-atendido",   marcarAtendidoRouter);
app.use("/api/citas-dia",         citasDiaRouter);
app.use("/api/citas-rango",       citasRangoRouter);
app.use("/api/proximas",          proximasRouter);
app.use("/api/bloquear-dia",      bloquearDiaRouter);
app.use("/api/dias-bloqueados",   diasBloqueadosRouter);

// Webhook de Telegram (sin autenticación por API key)
app.use("/webhook", webhookRouter);

// Health check sin auth para monitoring externo
app.get("/health", (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

// ── Manejo de errores ────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Arrancar servidor ────────────────────────────────────────
app.listen(ENV.PORT, () => {
  console.log(`✅ CitasMed API corriendo en http://localhost:${ENV.PORT}`);
  console.log(`   Supabase: ${ENV.SUPABASE_URL}`);
  console.log(`   Timezone: ${ENV.TIMEZONE}`);
  console.log(`   Seguridad: rate-limit + security-headers + request-logger activos`);
  iniciarRecordatorios();
});

export default app;
