import { ENV } from "../lib/env.js";

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error("❌ Uso: npx tsx src/bot/setup-webhook.ts https://tu-url.railway.app");
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

  const data = (await res.json()) as { ok: boolean; description?: string };

  if (data.ok) {
    console.log("✅ Webhook registrado:");
    console.log(`   ${webhookUrl}`);
  } else {
    console.error("❌ Error:", data.description);
  }
}

main().catch(console.error);
