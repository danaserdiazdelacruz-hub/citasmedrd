// src/application/types.ts
// Contratos centrales del sistema de application.
// Todos los módulos importan desde aquí — nunca definen sus propios tipos base.

import type { EstadoSesion } from "../persistence/repositories/index.js";
import type { OutgoingMessage } from "../channels/core/types.js";

// ─── Logger contextual ────────────────────────────────────────────────

export type LogCtx = {
  tenantId: string;
  chatId: string;
  estado: string;
  tz: string;
  updateId?: string;
};

export function logInfo(ctx: LogCtx, evt: string, extra?: Record<string, unknown>): void {
  console.log(
    `[orch] tenant=${ctx.tenantId.slice(0, 8)} chat=${ctx.chatId} estado=${ctx.estado} ${evt}`,
    extra ? JSON.stringify(extra) : "",
  );
}

export function logWarn(ctx: LogCtx, evt: string, extra?: Record<string, unknown>): void {
  console.warn(
    `[orch] tenant=${ctx.tenantId.slice(0, 8)} chat=${ctx.chatId} estado=${ctx.estado} ${evt}`,
    extra ?? "",
  );
}

export function logError(ctx: LogCtx, evt: string, err: unknown): void {
  console.error(
    `[orch] tenant=${ctx.tenantId.slice(0, 8)} chat=${ctx.chatId} estado=${ctx.estado} ${evt}`,
    err,
  );
}

// ─── Efectos declarativos ─────────────────────────────────────────────
// Los flows y handlers NO mutan el mundo directamente.
// Devuelven Effect[] y el EffectRunner los aplica en orden.

export type Effect =
  | { kind: "transition";   sesionId: string; estado: EstadoSesion; contexto?: Record<string, unknown> }
  | { kind: "reset";        sesionId: string; preserveMemoria: boolean }
  | { kind: "send";         messages: OutgoingMessage[] }
  | { kind: "append_user";  sesionId: string; content: string }
  | { kind: "append_assistant"; sesionId: string; content: string };

// ─── Resultado de un flow ─────────────────────────────────────────────

export interface FlowResult {
  effects: Effect[];
}

// ─── Contexto compartido entre flows ─────────────────────────────────
// Snapshot inmutable de todo lo que un flow necesita para ejecutarse.
// Se construye UNA VEZ en el orchestrator y se pasa a cada flow.

export interface FlowContext {
  tenantId: string;
  sesionId: string;
  sesionEstado: EstadoSesion;
  sesionContexto: Record<string, unknown>;
  logCtx: LogCtx;
}

// ─── Evento interno normalizado ───────────────────────────────────────
// El dispatcher trabaja con EventoInterno, nunca con IncomingMessage crudo.

export type EventoTipo = "command" | "button" | "text";

export interface EventoInterno {
  tipo: EventoTipo;
  // command
  command?: string;
  commandArg?: string;
  // button
  buttonTipo?: string;
  buttonValor?: string;
  // text
  text?: string;
  // metadata
  tenantId: string;
  chatId: string;
}

// ─── Config de handler devuelta por el dispatcher ─────────────────────

export type HandlerKind =
  | "command:start"
  | "command:cancelar"
  | "flow:agendar:iniciar"
  | "flow:agendar:identificar"
  | "flow:agendar:profesional_button"
  | "flow:agendar:agendar_con"
  | "flow:agendar:info_doctor"
  | "flow:agendar:buscar_otro"
  | "flow:agendar:sede"
  | "flow:agendar:servicio"
  | "flow:agendar:fecha"
  | "flow:agendar:slot"
  | "flow:agendar:tipo_pago"
  | "flow:agendar:confirmar"
  | "flow:cancelar:mostrar"
  | "flow:cancelar:ejecutar"
  | "flow:consultar:mostrar"
  | "flow:reagendar:iniciar"
  | "intent:llm"
  | "global:menu"
  | "global:reset_confirm"
  | "global:reset_execute"
  | "global:cancelar_flujo"
  | "global:cortesia"
  | "global:saludo"
  | "global:soft_reset_then_llm";

export interface HandlerConfig {
  kind: HandlerKind;
  payload?: Record<string, unknown>;
}
