// src/application/llm/tools.ts
// Catálogo de herramientas que el LLM puede llamar.
// TODAS son consultivas: solo SUGIEREN. El orchestrator valida y aplica.
//
// Mutación de citas SIEMPRE pasa por casos de uso → RPCs, NUNCA por LLM.

import type Anthropic from "@anthropic-ai/sdk";

// ─── Tools de detección/extracción ───────────────────────────────────

export const TOOL_DETECTAR_INTENCION: Anthropic.Tool = {
  name: "detectar_intencion",
  description:
    "Clasifica la intención del paciente en estado IDLE. Solo úsala cuando el paciente claramente quiere agendar/consultar/cancelar.",
  input_schema: {
    type: "object",
    properties: {
      intencion: {
        type: "string",
        enum: ["agendar", "consultar", "cancelar", "horarios", "precio", "otro"],
        description: "La intención principal.",
      },
      confianza: {
        type: "number",
        description: "Confianza 0.0 a 1.0. Solo se aplica si >=0.7.",
      },
    },
    required: ["intencion", "confianza"],
  },
};

export const TOOL_EXTRAER_TELEFONO: Anthropic.Tool = {
  name: "extraer_telefono",
  description:
    "Extrae un teléfono dominicano del texto. Solo si el paciente da un número claro de 10 dígitos.",
  input_schema: {
    type: "object",
    properties: {
      telefono_raw: {
        type: "string",
        description: "El teléfono tal cual lo escribió el paciente. El backend normaliza a E.164.",
      },
    },
    required: ["telefono_raw"],
  },
};

export const TOOL_EXTRAER_NOMBRE: Anthropic.Tool = {
  name: "extraer_nombre",
  description:
    "Extrae nombre y apellido del paciente. NO inventes. Solo si el paciente dice nombre + apellido claros.",
  input_schema: {
    type: "object",
    properties: {
      nombre: {
        type: "string",
        description: "Primer nombre.",
      },
      apellido: {
        type: "string",
        description: "Apellidos (puede ir vacío).",
      },
    },
    required: ["nombre"],
  },
};

// ─── Tools de sugerencia (avance del flujo) ──────────────────────────

export const TOOL_SUGERIR_SEDE: Anthropic.Tool = {
  name: "sugerir_sede",
  description:
    "Sugiere una sede cuando el paciente menciona ciudad o nombre de sede. Usa el ID exacto del prompt.",
  input_schema: {
    type: "object",
    properties: {
      sede_id: {
        type: "string",
        description: "UUID de la sede exactamente como aparece en el prompt.",
      },
    },
    required: ["sede_id"],
  },
};

export const TOOL_SUGERIR_SERVICIO: Anthropic.Tool = {
  name: "sugerir_servicio",
  description:
    "Sugiere un servicio cuando el paciente menciona el tipo. Usa el ID exacto del prompt.",
  input_schema: {
    type: "object",
    properties: {
      servicio_id: {
        type: "string",
        description: "UUID del servicio exactamente como aparece en el prompt.",
      },
    },
    required: ["servicio_id"],
  },
};

export const TOOL_SUGERIR_FECHA: Anthropic.Tool = {
  name: "sugerir_fecha",
  description:
    "Sugiere una fecha cuando el paciente menciona día, fecha o palabras como 'mañana', 'el lunes'. Solo días hábiles (L-V).",
  input_schema: {
    type: "object",
    properties: {
      fecha_iso: {
        type: "string",
        description: "Fecha en formato YYYY-MM-DD. Debe ser día hábil futuro.",
      },
    },
    required: ["fecha_iso"],
  },
};

export const TOOL_SUGERIR_HORA: Anthropic.Tool = {
  name: "sugerir_hora",
  description:
    "Sugiere una hora cuando el paciente menciona hora específica. Formato HH:MM en 24h.",
  input_schema: {
    type: "object",
    properties: {
      hora_hhmm: {
        type: "string",
        description: "Hora en formato HH:MM (24h), ej '10:00', '14:30'.",
      },
    },
    required: ["hora_hhmm"],
  },
};

// ─── Tool de control ─────────────────────────────────────────────────

export const TOOL_RESET_FLUJO: Anthropic.Tool = {
  name: "reset_flujo",
  description:
    "Reinicia el flujo y vuelve al menú principal. Úsala cuando el paciente claramente quiere abandonar ('ya no quiero', 'olvídalo', 'cancela').",
  input_schema: {
    type: "object",
    properties: {
      motivo: {
        type: "string",
        description: "Razón breve del reset.",
      },
    },
    required: ["motivo"],
  },
};

// ─── Conjuntos de tools por estado ───────────────────────────────────

export const TOOLS_IDLE: Anthropic.Tool[] = [
  TOOL_DETECTAR_INTENCION,
];

export const TOOLS_ELIGIENDO_SEDE: Anthropic.Tool[] = [
  TOOL_SUGERIR_SEDE,
  TOOL_RESET_FLUJO,
];

export const TOOLS_ELIGIENDO_SERVICIO: Anthropic.Tool[] = [
  TOOL_SUGERIR_SERVICIO,
  TOOL_RESET_FLUJO,
];

export const TOOLS_ELIGIENDO_HORA: Anthropic.Tool[] = [
  TOOL_SUGERIR_FECHA,
  TOOL_SUGERIR_HORA,
  TOOL_RESET_FLUJO,
];

export const TOOLS_PIDIENDO_NOMBRE: Anthropic.Tool[] = [
  TOOL_EXTRAER_NOMBRE,
  TOOL_RESET_FLUJO,
];

export const TOOLS_PIDIENDO_TELEFONO: Anthropic.Tool[] = [
  TOOL_EXTRAER_TELEFONO,
  TOOL_RESET_FLUJO,
];

export const TOOLS_DEFAULT: Anthropic.Tool[] = [
  TOOL_RESET_FLUJO,
];

/** Selecciona el conjunto de tools apropiado según el estado FSM. */
export function toolsParaEstado(estado: string): Anthropic.Tool[] {
  switch (estado) {
    case "IDLE":                return TOOLS_IDLE;
    case "ELIGIENDO_SEDE":      return TOOLS_ELIGIENDO_SEDE;
    case "ELIGIENDO_SERVICIO":  return TOOLS_ELIGIENDO_SERVICIO;
    case "ELIGIENDO_HORA":      return TOOLS_ELIGIENDO_HORA;
    case "PIDIENDO_NOMBRE":     return TOOLS_PIDIENDO_NOMBRE;
    case "PIDIENDO_TELEFONO":   return TOOLS_PIDIENDO_TELEFONO;
    case "ELIGIENDO_TIPO_PAGO": return TOOLS_DEFAULT;
    case "CONFIRMANDO":         return TOOLS_DEFAULT;
    default:                    return TOOLS_DEFAULT;
  }
}

/** Para compatibilidad con código viejo. */
export const ALL_TOOLS: Anthropic.Tool[] = [
  TOOL_DETECTAR_INTENCION,
  TOOL_EXTRAER_TELEFONO,
  TOOL_EXTRAER_NOMBRE,
  TOOL_SUGERIR_SEDE,
  TOOL_SUGERIR_SERVICIO,
  TOOL_SUGERIR_FECHA,
  TOOL_SUGERIR_HORA,
  TOOL_RESET_FLUJO,
];
