// ================================================================
// sesion.ts — Maneja la sesión del usuario en Supabase.
// Usa la tabla bot_sesiones (chat_id, canal, datos).
// Mucho más robusto que archivos temporales.
// ================================================================
import { supabase } from "../lib/supabase.js";
import { BotSesion } from "./types.js";

const CANAL = "telegram";

export async function getSesion(chatId: string): Promise<BotSesion> {
  const res = await supabase<any[]>("GET", "/rest/v1/bot_sesiones", null, {
    chat_id: `eq.${chatId}`,
    canal:   `eq.${CANAL}`,
    select:  "datos",
    limit:   "1",
  });
  return (res.data?.[0]?.datos as BotSesion) ?? { paso: "inicio" };
}

export async function setSesion(chatId: string, sesion: BotSesion): Promise<void> {
  await supabase(
    "POST",
    "/rest/v1/bot_sesiones",
    { chat_id: chatId, canal: CANAL, datos: sesion, actualizado_en: new Date().toISOString() },
    {},
    { "Prefer": "resolution=merge-duplicates,return=minimal" },
  );
}

export async function deleteSesion(chatId: string): Promise<void> {
  await supabase("DELETE", "/rest/v1/bot_sesiones", null, {
    chat_id: `eq.${chatId}`,
    canal:   `eq.${CANAL}`,
  });
}
