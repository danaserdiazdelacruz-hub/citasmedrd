// ================================================================
// claude-ai.ts — Usa la API de Claude para interpretar texto libre.
// Solo se llama cuando necesitamos entender intención del usuario.
// ================================================================
import { ENV } from "../lib/env.js";

async function preguntarClaude(systemPrompt: string, userMsg: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         ENV.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5-20251001", // rápido y barato para el bot
      max_tokens: 200,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userMsg }],
    }),
  });

  if (!res.ok) {
    console.error("[Claude AI] Error:", res.status, await res.text());
    return "";
  }

  const data = await res.json();
  return data.content?.[0]?.text?.trim() ?? "";
}

/** ¿Es primera vez con el doctor? Devuelve "primera" o "seguimiento" */
export async function interpretarTipoConsulta(texto: string): Promise<"primera" | "seguimiento" | null> {
  const respuesta = await preguntarClaude(
    `Eres un asistente médico. El paciente responde si es su primera vez con el doctor o si es un seguimiento.
Responde SOLO con una palabra: "primera" o "seguimiento".
Si no puedes determinar, responde "null".`,
    texto,
  );
  if (respuesta === "primera") return "primera";
  if (respuesta === "seguimiento") return "seguimiento";
  return null;
}

/** Extrae nombre completo del texto. Devuelve el nombre o null. */
export async function extraerNombre(texto: string): Promise<string | null> {
  const respuesta = await preguntarClaude(
    `Extrae el nombre completo de una persona del siguiente texto.
Responde SOLO con el nombre completo tal como aparece, sin puntuación extra.
Si no hay un nombre claro, responde "null".`,
    texto,
  );
  if (!respuesta || respuesta === "null" || respuesta.length < 3) return null;
  return respuesta;
}

/** Extrae número de teléfono. Devuelve solo dígitos o null. */
export async function extraerTelefono(texto: string): Promise<string | null> {
  const respuesta = await preguntarClaude(
    `Extrae el número de teléfono del siguiente texto.
Responde SOLO con los dígitos del número (sin espacios, guiones ni paréntesis).
Si no hay teléfono claro, responde "null".`,
    texto,
  );
  if (!respuesta || respuesta === "null") return null;
  const soloDigitos = respuesta.replace(/\D/g, "");
  if (soloDigitos.length < 10) return null;
  return soloDigitos;
}

/** ¿El usuario confirma o cancela? */
export async function interpretarConfirmacion(texto: string): Promise<"si" | "no" | null> {
  const respuesta = await preguntarClaude(
    `El usuario responde si confirma o cancela una cita médica.
Responde SOLO con "si" o "no".
Si no puedes determinar, responde "null".`,
    texto,
  );
  if (respuesta === "si") return "si";
  if (respuesta === "no") return "no";
  return null;
}

/** Detecta si el usuario quiere cancelar una cita existente */
export async function detectarIntencionCancelar(texto: string): Promise<boolean> {
  const respuesta = await preguntarClaude(
    `El usuario envía un mensaje a un bot de citas médicas.
¿El usuario quiere cancelar una cita existente?
Responde SOLO con "si" o "no".`,
    texto,
  );
  return respuesta === "si";
}
