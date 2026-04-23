// ================================================================
// env.ts — Valida que todas las variables necesarias existen.
// Si falta una, el servidor no arranca y te dice exactamente cuál.
// ================================================================
import fs from "fs";
import path from "path";

function loadDotenv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

loadDotenv();

function require_env(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`❌ Variable de entorno faltante: ${name}`);
    console.error(`   Agrega ${name}=... en tu archivo .env`);
    process.exit(1);
  }
  return val;
}

export const ENV = {
  SUPABASE_URL:       require_env("SUPABASE_URL"),
  SUPABASE_KEY:       require_env("SUPABASE_KEY"),
  API_SECRET:         require_env("API_SECRET"),
  TELEGRAM_BOT_TOKEN: require_env("TELEGRAM_BOT_TOKEN"),
  CLAUDE_API_KEY:     require_env("CLAUDE_API_KEY"),
  TIMEZONE:           process.env["TIMEZONE"] ?? "America/Santo_Domingo",
  PORT:               parseInt(process.env["PORT"] ?? "3000", 10),
};
