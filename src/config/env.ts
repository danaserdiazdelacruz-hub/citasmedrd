// src/config/env.ts
// Validación estricta de variables de entorno con Zod.
// Si falta algo crítico al arrancar, el proceso muere con mensaje claro.
// Ningún otro archivo del backend lee process.env directo — siempre pasa por aquí.

import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  // Entorno
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_ANON_KEY: z.string().min(20),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-"),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5-20251001"),

  // Telegram (opcional en producción cuando deje de usarse)
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // WhatsApp (opcional hasta que se conecte)
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),

  // Sentry (opcional en dev)
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().default("development"),

  // Seguridad
  CREDENTIALS_ENCRYPTION_KEY: z.string().length(64, {
    message: "CREDENTIALS_ENCRYPTION_KEY debe ser 64 chars hex (32 bytes). Generar con: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  }),

  // CORS
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Variables de entorno inválidas:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const ENV = Object.freeze({
  ...parsed.data,
  CORS_ALLOWED_ORIGINS: parsed.data.CORS_ALLOWED_ORIGINS.split(",").map(s => s.trim()),
  IS_PROD: parsed.data.NODE_ENV === "production",
  IS_DEV: parsed.data.NODE_ENV === "development",
  IS_TEST: parsed.data.NODE_ENV === "test",
});

export type Env = typeof ENV;
