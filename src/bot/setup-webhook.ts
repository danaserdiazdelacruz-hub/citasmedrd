// ================================================================
// setup-webhook.ts — Registra la URL del webhook en Telegram.
// Corre este script UNA SOLA VEZ después de desplegar.
//
// Uso:
//   npx tsx src/bot/setup-webhook.ts https://citasmedrd-production.up.railway.app
// ================================================================
import { ENV } from "../lib/env.js";

const url = process.argv[2];
if (!url) {
  console.error("❌ Debes pasar la URL de tu API como argumento.");
  console.error("   Ejemplo: npx tsx src/bot/setup-webhook.ts https://tu-url.railway.app");
  process.exit(1);
}

const webhookUrl = `${url.replace(/\/$/, "")}/webhook/telegram`;

const res = await fetch(
  `https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/setWebhook`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  }
);

const data = await res.json();

if (data.ok) {
  console.log("✅ Webhook registrado correctamente:");
  console.log(`   ${webhookUrl}`);
} else {
  console.error("❌ Error al registrar webhook:", data.description);
}
