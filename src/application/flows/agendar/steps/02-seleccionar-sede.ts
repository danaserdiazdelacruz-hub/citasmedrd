// src/application/flows/agendar/steps/02-seleccionar-sede.ts
// Paso 2: mostrar las sedes del profesional elegido.
// Mock único para test: profesionalesRepo.listarSedesPorProfesional

import { profesionalesRepo } from "../../../../persistence/repositories/index.js";
import * as M from "../../../messages.js";
import type { FlowContext, FlowResult } from "../../../types.js";
import { logWarn } from "../../../types.js";
import { fxSend, fxTransition } from "../../../effects/runner.js";

export interface SeleccionarSedeInput {
  ctx: FlowContext;
  profesional: { id: string; prefijo: string; nombre: string; apellido: string };
}

export async function seleccionarSede(input: SeleccionarSedeInput): Promise<FlowResult> {
  const { ctx, profesional } = input;

  const sedes = await profesionalesRepo.listarSedesPorProfesional(ctx.tenantId, profesional.id);

  if (sedes.length === 0) {
    logWarn(ctx.logCtx, `profesional ${profesional.id} sin sedes activas`);
    return {
      effects: [fxSend({ kind: "text", text: "Ese profesional no tiene sedes disponibles ahora." })],
    };
  }

  const profDisplay = `${profesional.prefijo} ${profesional.nombre} ${profesional.apellido}`;

  return {
    effects: [
      fxTransition(ctx.sesionId, "ELIGIENDO_SEDE", { profesional_id: profesional.id }),
      fxSend({
        kind: "buttons",
        text: M.eligiendoSede(profDisplay),
        buttons: sedes.map(s => ({
          label: s.sede.ciudad ? `${s.sede.nombre} (${s.sede.ciudad})` : s.sede.nombre,
          data: `sede:${s.profesionalSede.id}`,
        })),
      }),
    ],
  };
}
