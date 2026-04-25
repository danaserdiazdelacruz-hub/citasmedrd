// src/application/llm/tools.ts
// Catálogo de herramientas que el LLM puede llamar.
// TODAS son consultivas (no mutan estado). Las mutaciones las hace
// el orchestrator llamando casos de uso, no el LLM.
//
// Cada tool tiene un schema estricto. Si el LLM inventa parámetros raros,
// el orchestrator los rechaza al validar el input contra el schema.

import type Anthropic from "@anthropic-ai/sdk";

export const TOOL_DETECTAR_INTENCION: Anthropic.Tool = {
  name: "detectar_intencion",
  description:
    "Clasifica la intención del mensaje del paciente. Solo úsala una vez al inicio de cada mensaje del usuario.",
  input_schema: {
    type: "object",
    properties: {
      intencion: {
        type: "string",
        enum: ["agendar", "cancelar", "reagendar", "consultar", "horarios", "precio", "saludo", "otro"],
        description: "La intención principal del mensaje.",
      },
      confianza: {
        type: "number",
        description: "Confianza 0.0 a 1.0. Si <0.7, usa 'otro' y pide aclaración.",
      },
    },
    required: ["intencion", "confianza"],
  },
};

export const TOOL_EXTRAER_TELEFONO: Anthropic.Tool = {
  name: "extraer_telefono",
  description:
    "Extrae un número de teléfono dominicano del texto si está presente. Si no hay teléfono claro, no llames esta herramienta.",
  input_schema: {
    type: "object",
    properties: {
      telefono_raw: {
        type: "string",
        description: "El teléfono tal cual lo escribió el usuario, sin normalizar. El backend lo normalizará a E.164.",
      },
    },
    required: ["telefono_raw"],
  },
};

export const TOOL_EXTRAER_NOMBRE: Anthropic.Tool = {
  name: "extraer_nombre",
  description:
    "Extrae nombre y apellido del paciente del texto. NO inventes nombres. Si no hay nombre claro, no llames esta herramienta.",
  input_schema: {
    type: "object",
    properties: {
      nombre: {
        type: "string",
        description: "Solo el primer nombre.",
      },
      apellido: {
        type: "string",
        description: "Apellidos (puede ir vacío).",
      },
    },
    required: ["nombre"],
  },
};

/** Conjunto completo de tools disponibles para el orchestrator. */
export const ALL_TOOLS: Anthropic.Tool[] = [
  TOOL_DETECTAR_INTENCION,
  TOOL_EXTRAER_TELEFONO,
  TOOL_EXTRAER_NOMBRE,
];
