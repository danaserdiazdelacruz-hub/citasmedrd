// src/application/effects/runner.ts
// ÚNICO módulo autorizado para mutar el mundo:
//   - sessionManager (transitionTo, resetToIdle, appendUser, appendAssistant)
//   - acumular OutgoingMessage[]
//
// Todos los flows devuelven Effect[]. Este runner los aplica en orden.
// Nadie más toca sessionManager directamente.

import { sessionManager } from "../session-manager.js";
import type { Effect } from "../types.js";
import type { OutgoingMessage } from "../../channels/core/types.js";

export interface RunResult {
  messages: OutgoingMessage[];
}

export async function runEffects(effects: Effect[]): Promise<RunResult> {
  const messages: OutgoingMessage[] = [];

  for (const effect of effects) {
    switch (effect.kind) {
      case "transition":
        await sessionManager.transitionTo(effect.sesionId, effect.estado, effect.contexto);
        break;

      case "reset":
        await sessionManager.resetToIdle(effect.sesionId, effect.preserveMemoria);
        break;

      case "send":
        messages.push(...effect.messages);
        break;

      case "append_user":
        await sessionManager.appendUser(effect.sesionId, effect.content);
        break;

      case "append_assistant":
        await sessionManager.appendAssistant(effect.sesionId, effect.content);
        break;
    }
  }

  return { messages };
}

// ─── Helpers para construir effects ──────────────────────────────────
// Evitan que los flows construyan objetos Effect literales a mano.

export function fxTransition(
  sesionId: string,
  estado: Parameters<typeof sessionManager.transitionTo>[1],
  contexto?: Record<string, unknown>,
): Effect {
  return { kind: "transition", sesionId, estado, contexto };
}

export function fxReset(sesionId: string, preserveMemoria = true): Effect {
  return { kind: "reset", sesionId, preserveMemoria };
}

export function fxSend(...messages: OutgoingMessage[]): Effect {
  return { kind: "send", messages };
}

export function fxAppendUser(sesionId: string, content: string): Effect {
  return { kind: "append_user", sesionId, content };
}

export function fxAppendAssistant(sesionId: string, content: string): Effect {
  return { kind: "append_assistant", sesionId, content };
}
