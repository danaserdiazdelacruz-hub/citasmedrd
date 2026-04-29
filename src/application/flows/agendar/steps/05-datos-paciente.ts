// src/application/flows/agendar/steps/05-datos-paciente.ts
import { validateName, validatePhoneDO } from "../../../../domain/validators/index.js";
import * as M from "../../../messages.js";
import type { FlowContext, FlowResult } from "../../../types.js";
import { logWarn } from "../../../types.js";
import { fxSend, fxTransition, fxReset } from "../../../effects/runner.js";

// ─── Nombre ───────────────────────────────────────────────────────────

export async function recibirNombre(ctx: FlowContext, texto: string): Promise<FlowResult> {
  const val = validateName(texto);
  if (!val.valid) {
    return { effects: [fxSend({ kind: "text", text: M.nombreInvalido(val.reason ?? "nombre inválido") })] };
  }

  return {
    effects: [
      fxTransition(ctx.sesionId, "PIDIENDO_TELEFONO", {
        paciente_nombre: val.nombre,
        paciente_apellido: val.apellido,
      }),
      fxSend({ kind: "text", text: M.pidiendoTelefonoAgenda(val.nombre) }),
    ],
  };
}

// ─── Teléfono ─────────────────────────────────────────────────────────

export async function recibirTelefono(
  ctx: FlowContext,
  texto: string,
): Promise<FlowResult> {
  const phone = validatePhoneDO(texto);

  if (!phone.valid || !phone.normalized) {
    const intentos = ((ctx.sesionContexto["intentos_invalidos"] as number) ?? 0) + 1;

    if (intentos >= 3) {
      logWarn(ctx.logCtx, `usuario frustrado (${intentos} intentos), ofreciendo salida`);
      return {
        effects: [
          fxReset(ctx.sesionId, true),
          fxSend({ kind: "text", text: M.ofrecerSalida() }),
        ],
      };
    }

    return {
      effects: [
        fxTransition(ctx.sesionId, ctx.sesionEstado, { intentos_invalidos: intentos }),
        fxSend({ kind: "text", text: M.telefonoInvalido(phone.reason ?? "teléfono inválido") }),
      ],
    };
  }

  const baseCtx: Record<string, unknown> = {
    paciente_telefono: phone.normalized,
    paciente_telefono_conocido: phone.normalized,
    intentos_invalidos: 0,
  };

  const intencion = ctx.sesionContexto["intencion"] as string | undefined;

  if (intencion === "consultar" || intencion === "cancelar") {
    // Devolvemos la info necesaria para que el flow de consultar/cancelar tome el control
    return {
      effects: [
        fxTransition(ctx.sesionId, ctx.sesionEstado, baseCtx),
        // El orchestrator leerá esta señal y delegará al flow correcto
        fxSend({
          kind: "text" as const,
          text: `__DELEGAR:${intencion}:${phone.normalized}`,
        }),
      ],
    };
  }

  // Flujo agendar: continuar a tipo de pago
  return {
    effects: [
      fxTransition(ctx.sesionId, "ELIGIENDO_TIPO_PAGO", baseCtx),
      fxSend({
        kind: "buttons",
        text: M.eligiendoTipoPago(),
        buttons: M.opcionesTipoPago,
      }),
    ],
  };
}
