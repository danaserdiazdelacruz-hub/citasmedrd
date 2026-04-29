// src/application/flows/agendar/steps/03-seleccionar-servicio.ts
import { profesionalesRepo } from "../../../../persistence/repositories/index.js";
import * as M from "../../../messages.js";
import type { FlowContext, FlowResult } from "../../../types.js";
import { logWarn } from "../../../types.js";
import { fxSend, fxTransition, fxReset } from "../../../effects/runner.js";
import { transicionValida } from "../../../dispatcher/transitions.js";

export async function seleccionarServicio(ctx: FlowContext, psId: string): Promise<FlowResult> {
  if (!transicionValida(ctx.sesionEstado, "ELIGIENDO_SERVICIO")) {
    logWarn(ctx.logCtx, `transición inválida ${ctx.sesionEstado} → ELIGIENDO_SERVICIO`);
    return {
      effects: [
        fxReset(ctx.sesionId, true),
        fxSend({ kind: "text", text: "Volvamos al menú." }),
      ],
    };
  }

  const ps = await profesionalesRepo.findProfesionalSedeById(psId);
  if (!ps) {
    return { effects: [fxSend({ kind: "text", text: "Esa sede no está disponible. Intenta de nuevo." })] };
  }

  const servicios = await profesionalesRepo.listarServiciosPublicos(psId);
  if (servicios.length === 0) {
    return { effects: [fxSend({ kind: "text", text: "Esa sede no tiene servicios disponibles ahora." })] };
  }

  return {
    effects: [
      fxTransition(ctx.sesionId, "ELIGIENDO_SERVICIO", { profesional_sede_id: psId, sede_id: ps.sede_id }),
      fxSend({
        kind: "list",
        text: M.eligiendoServicio(),
        options: servicios.slice(0, 10).map(s => ({
          label: `${s.nombre} — RD$${s.precio.toLocaleString()}`,
          description: `${s.duracion_min} min`,
          data: `servicio:${s.id}`,
        })),
      }),
    ],
  };
}
