// src/application/flows/agendar/steps/04-seleccionar-hora.ts
import { profesionalesRepo } from "../../../../persistence/repositories/index.js";
import { listarHorariosLibres } from "../../../use-cases/index.js";
import { proximosDiasHabiles, formatFechaLarga, formatHoraCorta } from "../../../../domain/datetime.js";
import * as M from "../../../messages.js";
import type { FlowContext, FlowResult } from "../../../types.js";
import { logWarn } from "../../../types.js";
import { fxSend, fxTransition, fxReset } from "../../../effects/runner.js";
import { transicionValida } from "../../../dispatcher/transitions.js";

export async function seleccionarServicioButton(ctx: FlowContext, servicioId: string): Promise<FlowResult> {
  if (!transicionValida(ctx.sesionEstado, "ELIGIENDO_HORA")) {
    logWarn(ctx.logCtx, `transición inválida ${ctx.sesionEstado} → ELIGIENDO_HORA`);
    return { effects: [fxReset(ctx.sesionId, true), fxSend({ kind: "text", text: "Volvamos al menú." })] };
  }

  const servicio = await profesionalesRepo.findServicioById(servicioId);
  if (!servicio) {
    return { effects: [fxSend({ kind: "text", text: "Ese servicio no está disponible." })] };
  }

  return {
    effects: [
      fxTransition(ctx.sesionId, "ELIGIENDO_HORA", {
        servicio_id: servicioId,
        servicio_nombre: servicio.nombre,
        servicio_precio: servicio.precio,
        servicio_duracion: servicio.duracion_min,
      }),
      fxSend({
        kind: "buttons",
        text: M.eligiendoDia(servicio.nombre, servicio.precio, servicio.duracion_min),
        buttons: proximosDiasHabiles(5, ctx.logCtx.tz).map(d => ({
          label: d.label,
          data: `fecha:${d.iso}`,
        })),
      }),
    ],
  };
}

export async function seleccionarFecha(ctx: FlowContext, fecha: string): Promise<FlowResult> {
  const psId = ctx.sesionContexto["profesional_sede_id"] as string | undefined;
  if (!psId) {
    logWarn(ctx.logCtx, "fecha sin profesional_sede_id en contexto, reseteando");
    return { effects: [fxReset(ctx.sesionId, true), fxSend({ kind: "text", text: "Volvamos al menú." })] };
  }

  const slots = await listarHorariosLibres({ profesionalSedeId: psId, fecha });

  if (slots.length === 0) {
    return {
      effects: [fxSend({
        kind: "buttons",
        text: M.diaSinHorarios(formatFechaLarga(fecha)),
        buttons: proximosDiasHabiles(5, ctx.logCtx.tz).map(d => ({ label: d.label, data: `fecha:${d.iso}` })),
      })],
    };
  }

  return {
    effects: [
      fxTransition(ctx.sesionId, "ELIGIENDO_HORA", { fecha_seleccionada: fecha }),
      fxSend({
        kind: "buttons",
        text: M.eligiendoHora(formatFechaLarga(fecha)),
        buttons: slots.slice(0, 8).map(s => ({
          label: formatHoraCorta(s.iniciaEn, ctx.logCtx.tz),
          data: `slot:${s.iniciaEn}`,
        })),
      }),
    ],
  };
}

export async function seleccionarSlot(ctx: FlowContext, iniciaEn: string): Promise<FlowResult> {
  if (!transicionValida(ctx.sesionEstado, "PIDIENDO_NOMBRE")) {
    logWarn(ctx.logCtx, `transición inválida ${ctx.sesionEstado} → PIDIENDO_NOMBRE`);
    return { effects: [fxReset(ctx.sesionId, true), fxSend({ kind: "text", text: "Volvamos al menú." })] };
  }

  return {
    effects: [
      fxTransition(ctx.sesionId, "PIDIENDO_NOMBRE", { inicia_en: iniciaEn }),
      fxSend({ kind: "text", text: M.pidiendoNombre() }),
    ],
  };
}
