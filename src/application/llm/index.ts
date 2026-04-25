// src/application/llm/index.ts

export { callLLM } from "./client.js";
export type { LLMTurn, LLMCallOptions, LLMResponse } from "./client.js";

export { buildSystemPrompt } from "./prompt-builder.js";
export type { PromptContext } from "./prompt-builder.js";

export { ALL_TOOLS, TOOL_DETECTAR_INTENCION, TOOL_EXTRAER_TELEFONO, TOOL_EXTRAER_NOMBRE } from "./tools.js";
