// src/application/flows/agendar/guards/cita-activa.ts
// Verifica si el paciente ya tiene cita activa CON EL MISMO PROFESIONAL.
// Con profesional distinto devuelve null → flujo continúa libre.
// Única fuente de verdad para esta regla de negocio.

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
  /** Si se provee, solo bloquea si hay cita activa con este profesional_id. */
  profesionalId?: string;
}

export async function verificarCitaActiva(
  input: CitaActivaInput,
): Promise<OutgoingMessage | null> {
  const { tenantId, telefonoConocido, tz, ctx, profesionalId } = input;

  if (!telefonoConocido) return null;

  try {
    const citas = await consultarCitasActivasPorTelefono(tenantId, telefonoConocido);
    if (citas.length === 0) return null;

    // Con profesional distinto: citas independientes, no bloquear.
    const relevantes = profesionalId
      ? citas.filter(c => c.profesionalId === profesionalId)
      : citas;

    if (relevantes.length === 0) return null;

    const c = relevantes[0];
    const doctor = `${c.profesionalNombre} ${c.profesionalApellido}`.trim();
    logInfo(ctx, "cita activa con mismo profesional", { codigo: c.codigo, doctor });

    return {
      kind: "buttons",
      text: M.yaTienesCitaActiva(
        formatFechaHora(c.iniciaEn, tz),
        c.servicioNombre,
        c.codigo,
        doctor,
      ),
      buttons: M.opcionesYaTieneCita,
    };
  } catch (err) {
    logWarn(ctx, "no pude verificar citas activas (continuando)", { err: String(err) });
    return null;
  }
}
