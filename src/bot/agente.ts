// src/bot/agente.ts — Núcleo del agente con Claude Tool Calling
// Recibe mensaje → Claude decide → ejecuta tools → responde

import { ENV } from "../lib/env.js";
import { buildSystemPrompt } from "./prompt.js";
import { TOOL_DEFINITIONS } from "./toolDefs.js";
import { ejecutarTool } from "./toolExecutors.js";

const MAX_ITERACIONES = 8;

interface Mensaje {
  role: "user" | "assistant";
  content: any; // string | content blocks
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: any;
}

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolResultMsg {
  role: "user";
  content: { type: "tool_result"; tool_use_id: string; content: string }[];
}

/**
 * Ejecuta el loop del agente.
 * Recibe el historial y el mensaje nuevo del usuario.
 * Devuelve el texto final para enviar al paciente.
 */
export async function ejecutarAgente(
  historial: Mensaje[],
  textoUsuario: string
): Promise<{ respuesta: string; historialActualizado: Mensaje[] }> {

  // Copiar historial para no mutar el original
  const hist: any[] = [...historial];

  // Agregar mensaje del usuario
  hist.push({ role: "user", content: textoUsuario });

  let iteracion = 0;

  while (iteracion < MAX_ITERACIONES) {
    iteracion++;
    console.log(`[AGENTE] Iteración ${iteracion}/${MAX_ITERACIONES}`);

    // Llamar a Claude
    const response = await llamarClaude(hist);

    if (!response) {
      return {
        respuesta: "Disculpe, tuve un problema técnico. Escriba /start para reiniciar.",
        historialActualizado: hist,
      };
    }

    const contentBlocks = response.content ?? [];
    const stopReason = response.stop_reason;

    // Extraer texto y tool_use
    const textos = contentBlocks.filter((b: any) => b.type === "text") as TextBlock[];
    const toolCalls = contentBlocks.filter((b: any) => b.type === "tool_use") as ToolUseBlock[];

    // Si hay tool calls → ejecutar y seguir el loop
    if (stopReason === "tool_use" && toolCalls.length > 0) {
      // Agregar la respuesta de Claude (con tool_use) al historial
      hist.push({ role: "assistant", content: contentBlocks });

      // Ejecutar TODAS las tools que pidió
      const toolResults: { type: "tool_result"; tool_use_id: string; content: string }[] = [];

      for (const tc of toolCalls) {
        console.log(`[AGENTE] Tool: ${tc.name}`);
        const resultado = await ejecutarTool(tc.name, tc.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: resultado,
        });
      }

      // Agregar resultados al historial
      hist.push({ role: "user", content: toolResults });

      // Continuar el loop — Claude va a procesar los resultados
      continue;
    }

    // Si no hay tool calls → Claude respondió con texto final
    const textoFinal = textos.map(t => t.text).join("\n").trim();

    // Agregar respuesta al historial (solo el texto, limpio)
    hist.push({ role: "assistant", content: textoFinal });

    console.log(`[AGENTE] Respuesta final (${iteracion} iteraciones)`);

    return {
      respuesta: textoFinal || "Escriba /start para comenzar.",
      historialActualizado: hist,
    };
  }

  // Si llegamos al máximo de iteraciones
  console.error("[AGENTE] Máximo de iteraciones alcanzado");
  return {
    respuesta: "Disculpe, no pude completar la solicitud. Escriba /start para reiniciar.",
    historialActualizado: hist,
  };
}

/**
 * Llama a Claude con tool calling
 */
async function llamarClaude(mensajes: any[]): Promise<any | null> {
  try {
    // Limpiar historial: solo mantener últimos 20 mensajes
    const msgLimpios = mensajes.slice(-20);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ENV.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: buildSystemPrompt(),
        tools: TOOL_DEFINITIONS,
        messages: msgLimpios,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[CLAUDE] Error ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }

    return await res.json();
  } catch (err: any) {
    console.error("[CLAUDE] Error de red:", err.message);
    return null;
  }
}
