// src/application/llm/client.ts
// Wrapper de Anthropic SDK. Envuelve Claude Haiku con tool use estructurado.
//
// Reglas:
//   - El LLM nunca decide horarios, códigos, timestamps ni precios.
//   - Solo clasifica intención y extrae entidades en lenguaje natural.
//   - Las herramientas que expone son CONSULTIVAS, no MUTATIVAS:
//       * detectar_intencion → ('agendar'|'cancelar'|'consultar'|'horarios'|'saludo'|'otro')
//       * extraer_telefono   → string E.164 candidato
//       * extraer_nombre     → { nombre, apellido }
//   - Las mutaciones (crear cita, cancelar) las hace el orchestrator
//     llamando casos de uso, NUNCA el LLM directamente.

import Anthropic from "@anthropic-ai/sdk";
import { ENV } from "../../config/env.js";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: ENV.ANTHROPIC_API_KEY });
  return _client;
}

export interface LLMTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LLMCallOptions {
  systemPrompt: string;
  history: LLMTurn[];
  userMessage: string;
  tools?: Anthropic.Tool[];
  maxTokens?: number;
}

export interface LLMResponse {
  text: string;                                    // texto plano (puede estar vacío si solo hay tool use)
  toolUses: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  stopReason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export async function callLLM(opts: LLMCallOptions): Promise<LLMResponse> {
  const client = getClient();

  const messages: Anthropic.MessageParam[] = [
    ...opts.history.map(t => ({
      role: t.role,
      content: t.content,
    } as Anthropic.MessageParam)),
    { role: "user", content: opts.userMessage },
  ];

  const response = await client.messages.create({
    model: ENV.ANTHROPIC_MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.systemPrompt,
    messages,
    tools: opts.tools,
  });

  let text = "";
  const toolUses: LLMResponse["toolUses"] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolUses.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }

  return {
    text: text.trim(),
    toolUses,
    stopReason: response.stop_reason,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}
