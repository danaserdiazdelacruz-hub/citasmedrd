// src/application/flows/cancelar/index.ts
// Cancelar citas: primero por código, luego por teléfono como fallback.

import { consultarCitasActivasPorTelefono, consultarCitaPorCodigo, cancelarCita } from "../../use-cases/index.js";
import { formatFechaHora } from "../../../domain/datetime.js";
import { DomainError } from "../../../domain/errors.js";
import * as M from "../../messages.js";
import type { FlowContext, FlowResult } from "../../types.js";
import { logInfo, logError } from "../../types.js";
import { fxSend, fxTransition, fxReset } from "../../effects/runner.js";

export async function mostrarCitasCancelarPorCodigo(
  ctx: FlowContext,
  codigo: string,
): Promise<FlowResult> {
  const cita = await consultarCitaPorCodigo(ctx.tenantId, codigo.toUpperCase());

  if (!cita || !["pendiente", "confirmada"].includes(cita.estado)) {
    return {
      effects: [fxSend({
        kind: "buttons",
        text: `No encontré una cita activa con el código *${codigo.toUpperCase()}*. Verifica el código o escribe tu teléfono.`,
        buttons: [{ label: "🏠 Volver al menú", data: "menu:inicio" }],
      })],
    };
  }

  const doctor = `${cita.profesionalNombre} ${cita.profesionalApellido}`.trim();
  return {
    effects: [
      fxTransition(ctx.sesionId, "CANCELANDO_CITA", {}),
      fxSend({
        kind: "buttons",
        text: M.citasActivasResumen([{
          codigo: cita.codigo,
          fechaHora: formatFechaHora(cita.iniciaEn, ctx.logCtx.tz),
          servicio: cita.servicioNombre,
          doctor,
        }]) + M.eligeCitaCancelar(),
        buttons: [{ label: `❌ Cancelar ${cita.codigo}`, data: `cancelar_cita:${cita.id}` }],
      }),
    ],
  };
}

export async function mostrarCitasCancelarPorTelefono(
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
    doctor: `${c.profesionalNombre} ${c.profesionalApellido}`.trim(),
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

export async function pedirCodigoOTelefonoCancelar(ctx: FlowContext): Promise<FlowResult> {
  return {
    effects: [
      fxTransition(ctx.sesionId, "PIDIENDO_TELEFONO", { intencion: "cancelar" }),
      fxSend({
        kind: "text",
        text: "¿Cuál es el código de la cita que deseas cancelar? (ej: *CITA-ABC123*)\nSi no lo tienes, escribe tu número de teléfono.",
      }),
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
