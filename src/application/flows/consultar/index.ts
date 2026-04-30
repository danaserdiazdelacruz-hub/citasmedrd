// src/application/flows/consultar/index.ts
import { consultarCitasActivasPorTelefono } from "../../use-cases/index.js";
import { formatFechaHora } from "../../../domain/datetime.js";
import * as M from "../../messages.js";
import type { FlowContext, FlowResult } from "../../types.js";
import { fxSend, fxTransition, fxReset } from "../../effects/runner.js";

export async function mostrarCitasConsulta(
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
      fxReset(ctx.sesionId, true),
      fxSend({
        kind: "buttons",
        text: M.citasActivasResumen(resumen),
        buttons: M.botonVolverMenu,
      }),
    ],
  };
}

export async function pedirTelefonoConsulta(ctx: FlowContext): Promise<FlowResult> {
  return {
    effects: [
      fxTransition(ctx.sesionId, "PIDIENDO_TELEFONO", { intencion: "consultar" }),
      fxSend({ kind: "text", text: M.pidiendoTelefonoConsulta() }),
    ],
  };
}
