// ================================================================
// index.ts — Punto de entrada del servidor CitasMed API
// ================================================================
import "express-async-errors";           // captura errores async sin try/catch en cada ruta
import express from "express";
import { ENV } from "./lib/env.js";      // valida .env al arrancar
import { authenticate } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/errors.js";

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

const app = express();

// ── Middlewares globales ─────────────────────────────────────
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  next();
});
app.options("*", (_req, res) => res.status(204).send());

// ── Rutas ────────────────────────────────────────────────────
// Todas las rutas requieren autenticación
app.use("/api", authenticate);

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

// ── Manejo de errores ────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Arrancar servidor ────────────────────────────────────────
app.listen(ENV.PORT, () => {
  console.log(`✅ CitasMed API corriendo en http://localhost:${ENV.PORT}`);
  console.log(`   Supabase: ${ENV.SUPABASE_URL}`);
  console.log(`   Timezone: ${ENV.TIMEZONE}`);
});

export default app;
