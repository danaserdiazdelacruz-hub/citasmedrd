// src/application/llm/index.ts

export { callLLM, LLMUnavailableError } from "./client.js";
export type { LLMTurn, LLMCallOptions, LLMResponse } from "./client.js";

export { buildSystemPrompt } from "./prompt-builder.js";
export type { SesionContexto, DatosTenantParaPrompt } from "./prompt-builder.js";

export {
  ALL_TOOLS,
  toolsParaEstado,
  TOOL_DETECTAR_INTENCION,
  TOOL_EXTRAER_TELEFONO,
  TOOL_EXTRAER_NOMBRE,
  TOOL_SUGERIR_SEDE,
  TOOL_SUGERIR_SERVICIO,
  TOOL_SUGERIR_FECHA,
  TOOL_SUGERIR_HORA,
  TOOL_RESET_FLUJO,
} from "./tools.js";
