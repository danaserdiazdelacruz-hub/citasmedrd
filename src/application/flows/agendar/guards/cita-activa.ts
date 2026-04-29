// src/application/flows/agendar/guards/cita-activa.ts
// Verificación de cita activa del paciente.
// ÚNICA fuente de verdad — extraída de las 3 duplicaciones en el orquestador anterior.
//
// Si el paciente ya tiene cita activa y no se fuerza nueva, devuelve el
// OutgoingMessage de "ya tienes cita". Si no hay cita activa (o no hay teléfono
// conocido), devuelve null → el flujo continúa normal.

import { consultarCitasActivasPorTelefono } from "../../../use-cases/index.js";
import { formatFechaHora } from "../../../../domain/datetime.js";
import * as M from "../../../messages.js";
import type { OutgoingMessage } from "../../../../channels/core/types.js";
import type { LogCtx } from "../../../types.js";
import { logInfo, logWarn } from "../../../types.js";

export interface CitaActivaInput {
  tenantId: string;
  telefonoConocido: string | undefined;
  tz: string;
  ctx: LogCtx;
}

export async function verificarCitaActiva(
  input: CitaActivaInput,
): Promise<OutgoingMessage | null> {
  const { tenantId, telefonoConocido, tz, ctx } = input;

  if (!telefonoConocido) return null;

  try {
    const citas = await consultarCitasActivasPorTelefono(tenantId, telefonoConocido);
    if (citas.length === 0) return null;

    const c = citas[0];
    logInfo(ctx, "paciente ya tiene cita activa, ofreciendo opciones", { codigo: c.codigo });

    return {
      kind: "buttons",
      text: M.yaTienesCitaActiva(
        formatFechaHora(c.iniciaEn, tz),
        c.servicioNombre,
        c.codigo,
      ),
      buttons: M.opcionesYaTieneCita,
    };
  } catch (err) {
    logWarn(ctx, "no pude verificar citas activas (continuando)", { err: String(err) });
    return null;
  }
}
