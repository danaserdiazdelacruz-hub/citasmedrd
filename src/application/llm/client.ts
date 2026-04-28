// src/application/llm/client.ts
// Wrapper de Anthropic SDK con resiliencia:
//   - Retry con backoff exponencial en errores transitorios
//   - Timeout duro por intento (8s)
//   - Circuit breaker: 3 fallos seguidos → abierto 60s
//   - Logging con contexto
//
// Filosofía: el LLM es OPCIONAL. Si falla, el orchestrator usa plantillas.

import Anthropic from "@anthropic-ai/sdk";
import { ENV } from "../../config/env.js";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: ENV.ANTHROPIC_API_KEY });
  return _client;
}

// ─── Configuración ───────────────────────────────────────────────────

const TIMEOUT_PER_ATTEMPT_MS = 8000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];      // por intento
const BREAKER_OPEN_THRESHOLD = 3;
const BREAKER_OPEN_DURATION_MS = 60000;

// ─── Tipos públicos ──────────────────────────────────────────────────

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
  text: string;
  toolUses: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  stopReason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

/** Error específico de LLM. El orchestrator lo trata como "no disponible". */
export class LLMUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "LLMUnavailableError";
  }
}

// ─── Circuit breaker ─────────────────────────────────────────────────

class CircuitBreaker {
  private consecutiveFails = 0;
  private openUntil = 0;

  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  recordSuccess(): void {
    this.consecutiveFails = 0;
  }

  recordFailure(): void {
    this.consecutiveFails++;
    if (this.consecutiveFails >= BREAKER_OPEN_THRESHOLD) {
      this.openUntil = Date.now() + BREAKER_OPEN_DURATION_MS;
      console.warn(
        `[llm] circuit breaker ABIERTO (${this.consecutiveFails} fallos seguidos). ` +
        `Cerrará en ${BREAKER_OPEN_DURATION_MS / 1000}s`
      );
    }
  }

  msUntilClose(): number {
    return Math.max(0, this.openUntil - Date.now());
  }
}

const breaker = new CircuitBreaker();

// ─── Helpers ─────────────────────────────────────────────────────────

function isPermanentError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: number }).status;
  // 4xx (no 408, 429): bad request, auth, model not found, etc.
  if (status !== undefined && status >= 400 && status < 500
      && status !== 408 && status !== 429) return true;
  return false;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LLM timeout: ${ms}ms`)), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── API pública ─────────────────────────────────────────────────────

/**
 * Llama al LLM con retry + circuit breaker + timeout.
 * Lanza LLMUnavailableError si falla todos los intentos o el breaker está abierto.
 */
export async function callLLM(opts: LLMCallOptions): Promise<LLMResponse> {
  // Circuit breaker: si está abierto, fallar inmediato
  if (breaker.isOpen()) {
    const ms = breaker.msUntilClose();
    throw new LLMUnavailableError(
      `Circuit breaker abierto (${Math.ceil(ms / 1000)}s para reintentar)`
    );
  }

  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await withTimeout(callOnce(opts), TIMEOUT_PER_ATTEMPT_MS);
      breaker.recordSuccess();
      return result;
    } catch (err) {
      lastErr = err;

      // Error permanente: no reintentar
      if (isPermanentError(err)) {
        breaker.recordFailure();
        const status = (err as { status?: number }).status;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[llm] error permanente status=${status}: ${msg}`);
        throw new LLMUnavailableError(`LLM rechazó la petición: ${msg}`, err);
      }

      // Transitorio: reintentar si hay intentos restantes
      const remaining = MAX_ATTEMPTS - attempt;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[llm] intento ${attempt}/${MAX_ATTEMPTS} falló: ${errMsg}. ` +
        (remaining > 0 ? `Reintentando en ${BACKOFF_MS[attempt - 1]}ms…` : `Sin más intentos.`)
      );

      if (remaining > 0) {
        await sleep(BACKOFF_MS[attempt - 1]);
      }
    }
  }

  // Todos los intentos fallaron
  breaker.recordFailure();
  const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new LLMUnavailableError(`LLM falló tras ${MAX_ATTEMPTS} intentos: ${errMsg}`, lastErr);
}

async function callOnce(opts: LLMCallOptions): Promise<LLMResponse> {
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

/** Solo para tests. Resetea el estado del breaker. */
export function _resetBreaker(): void {
  breaker.recordSuccess();
}
