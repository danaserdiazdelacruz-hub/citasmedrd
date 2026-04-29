// src/application/flows/cancelar/index.ts
import { consultarCitasActivasPorTelefono, cancelarCita } from "../../use-cases/index.js";
import { formatFechaHora } from "../../../domain/datetime.js";
import { DomainError } from "../../../domain/errors.js";
import * as M from "../../messages.js";
import type { FlowContext, FlowResult } from "../../types.js";
import { logInfo, logError } from "../../types.js";
import { fxSend, fxTransition, fxReset } from "../../effects/runner.js";

export async function mostrarCitasCancelar(
  ctx: FlowContext,
  telefono: string,
): Promise<FlowResult> {
  const citas = await consultarCitasActivasPorTelefono(ctx.tenantId, telefono);

  if (citas.length === 0) {
    return {
      effects: [
        fxReset(ctx.sesionId, true),
        fxSend({
          kind: "buttons",
          text: M.sinCitasActivas(),
          buttons: [
            { label: "📅 Agendar ahora", data: "intent:agendar" },
            { label: "🏠 Volver al menú", data: "menu:inicio" },
          ],
        }),
      ],
    };
  }

  const resumen = citas.map(c => ({
    codigo: c.codigo,
    fechaHora: formatFechaHora(c.iniciaEn, ctx.logCtx.tz),
    servicio: c.servicioNombre,
  }));

  return {
    effects: [
      fxTransition(ctx.sesionId, "CANCELANDO_CITA", {}),
      fxSend({
        kind: "buttons",
        text: M.citasActivasResumen(resumen) + M.eligeCitaCancelar(),
        buttons: citas.slice(0, 8).map(c => ({
          label: `❌ Cancelar ${c.codigo}`,
          data: `cancelar_cita:${c.id}`,
        })),
      }),
    ],
  };
}

export async function pedirTelefonoCancelar(ctx: FlowContext): Promise<FlowResult> {
  return {
    effects: [
      fxTransition(ctx.sesionId, "PIDIENDO_TELEFONO", { intencion: "cancelar" }),
      fxSend({ kind: "text", text: M.pidiendoTelefonoCancelar() }),
    ],
  };
}

export async function ejecutarCancelacion(
  ctx: FlowContext,
  citaId: string,
): Promise<FlowResult> {
  try {
    await cancelarCita({
      tenantId: ctx.tenantId,
      citaId,
      motivo: "cancelada por paciente vía bot",
    });
    logInfo(ctx.logCtx, `cita cancelada: ${citaId}`);
    return {
      effects: [
        fxReset(ctx.sesionId, true),
        fxSend({ kind: "text", text: M.citaCancelada() }),
      ],
    };
  } catch (err) {
    if (err instanceof DomainError) {
      return { effects: [fxSend({ kind: "text", text: M.errorAgendar(err.message) })] };
    }
    logError(ctx.logCtx, "error cancelando cita", err);
    return { effects: [fxSend({ kind: "text", text: M.errorTecnico() })] };
  }
}
