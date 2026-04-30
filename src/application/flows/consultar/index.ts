// src/application/flows/consultar/index.ts
// Consultar citas: primero por código, luego por teléfono como fallback.

import { consultarCitasActivasPorTelefono, consultarCitaPorCodigo } from "../../use-cases/index.js";
import { formatFechaHora } from "../../../domain/datetime.js";
import * as M from "../../messages.js";
import type { FlowContext, FlowResult } from "../../types.js";
import { fxSend, fxTransition, fxReset } from "../../effects/runner.js";

export async function mostrarCitasPorCodigo(
  ctx: FlowContext,
  codigo: string,
): Promise<FlowResult> {
  const cita = await consultarCitaPorCodigo(ctx.tenantId, codigo.toUpperCase());

  if (!cita || !["pendiente", "confirmada"].includes(cita.estado)) {
    return {
      effects: [fxSend({
        kind: "buttons",
        text: `No encontré una cita activa con el código *${codigo.toUpperCase()}*. Verifica que lo copiaste bien o escribe tu teléfono.`,
        buttons: [{ label: "🏠 Volver al menú", data: "menu:inicio" }],
      })],
    };
  }

  const doctor = `${cita.profesionalNombre} ${cita.profesionalApellido}`.trim();
  return {
    effects: [
      fxReset(ctx.sesionId, true),
      fxSend({
        kind: "buttons",
        text: M.citasActivasResumen([{
          codigo: cita.codigo,
          fechaHora: formatFechaHora(cita.iniciaEn, ctx.logCtx.tz),
          servicio: cita.servicioNombre,
          doctor,
        }]),
        buttons: M.botonVolverMenu,
      }),
    ],
  };
}

export async function mostrarCitasPorTelefono(
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

export async function pedirCodigoOTelefonoConsulta(ctx: FlowContext): Promise<FlowResult> {
  return {
    effects: [
      fxTransition(ctx.sesionId, "PIDIENDO_TELEFONO", { intencion: "consultar" }),
      fxSend({
        kind: "text",
        text: "¿Cuál es el código de tu cita? (ej: *CITA-ABC123*)\nSi no lo tienes, escribe tu número de teléfono.",
      }),
    ],
  };
}
