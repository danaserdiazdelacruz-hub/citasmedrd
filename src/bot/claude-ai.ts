import { ENV } from "../lib/env.js";

async function preguntarClaude(systemPrompt: string, userMsg: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ENV.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  if (!res.ok) return "";
  const data = (await res.json()) as { content?: { text?: string }[] };
  return data.content?.[0]?.text?.trim() ?? "";
}

export async function interpretarTipoConsulta(texto: string): Promise<"primera" | "seguimiento" | null> {
  const r = await preguntarClaude(`¿Es primera vez o seguimiento? Responde SOLO: "primera" o "seguimiento". Si no puedes, responde "null".`, texto);
  if (r === "primera") return "primera";
  if (r === "seguimiento") return "seguimiento";
  return null;
}

export async function extraerNombre(texto: string): Promise<string | null> {
  const r = await preguntarClaude(`Extrae el nombre completo. Responde SOLO el nombre. Si no hay, responde "null".`, texto);
  if (!r || r === "null" || r.length < 3) return null;
  return r;
}

export async function extraerTelefono(texto: string): Promise<string | null> {
  const r = await preguntarClaude(`Extrae el teléfono. Responde SOLO los dígitos. Si no hay, responde "null".`, texto);
  if (!r || r === "null") return null;
  const digits = r.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits;
}

export async function interpretarConfirmacion(texto: string): Promise<"si" | "no" | null> {
  const r = await preguntarClaude(`¿Confirma o cancela? Responde SOLO: "si" o "no". Si no puedes, responde "null".`, texto);
  if (r === "si") return "si";
  if (r === "no") return "no";
  return null;
}

export async function detectarIntencionCancelar(texto: string): Promise<boolean> {
  const r = await preguntarClaude(`¿El usuario quiere cancelar una cita? Responde SOLO: "si" o "no".`, texto);
  return r === "si";
}
