// src/application/flows/agendar/steps/01-identificar-doctor.ts
// Paso 1: identificar al profesional por nombre/apellido/teléfono/extensión.
// Retorna FlowResult con effects declarativos.
// Un solo mock necesario para test: profesionalesRepo.

import { profesionalesRepo } from "../../../../persistence/repositories/index.js";
import { validatePhoneDO } from "../../../../domain/validators/index.js";
import * as M from "../../../messages.js";
import type { FlowContext, FlowResult } from "../../../types.js";
import { logInfo, logWarn } from "../../../types.js";
import { fxSend } from "../../../effects/runner.js";

export interface IdentificarDoctorInput {
  ctx: FlowContext;
  texto: string;
}

/**
 * Devuelve FlowResult o null.
 * null significa: no hubo match razonable → el caller debe dejar que el LLM lo maneje.
 */
export async function identificarDoctor(
  input: IdentificarDoctorInput,
): Promise<FlowResult | null> {
  const { ctx, texto } = input;
  const { tenantId, logCtx } = ctx;

  type ProfBasico = { id: string; prefijo: string; nombre: string; apellido: string; especialidad: string | null };
  let matchesPorTelefono: ProfBasico[] = [];
  let matchesPorExtension: ProfBasico[] = [];
  let matchesPorNombre: ProfBasico[] = [];

  // 1) Búsqueda por teléfono normalizado
  const normalized = validatePhoneDO(texto);
  if (normalized.valid && normalized.normalized) {
    try {
      const res = await profesionalesRepo.buscarPorTelefonoOExtension(tenantId, normalized.normalized);
      matchesPorTelefono = res.map(p => ({ id: p.id, prefijo: p.prefijo, nombre: p.nombre, apellido: p.apellido, especialidad: p.especialidad }));
    } catch (err) {
      logWarn(logCtx, "búsqueda por teléfono falló", { err: String(err) });
    }
  }

  // 2) Búsqueda por extensión corta
  if (matchesPorTelefono.length === 0 && /^\d{1,6}$/.test(texto.replace(/\s/g, ""))) {
    try {
      const res = await profesionalesRepo.buscarPorTelefonoOExtension(tenantId, texto.replace(/\s/g, ""));
      matchesPorExtension = res.map(p => ({ id: p.id, prefijo: p.prefijo, nombre: p.nombre, apellido: p.apellido, especialidad: p.especialidad }));
    } catch (err) {
      logWarn(logCtx, "búsqueda por extensión falló", { err: String(err) });
    }
  }

  // 3) Búsqueda por nombre
  const totalTel = matchesPorTelefono.length + matchesPorExtension.length;
  if (totalTel === 0) {
    const queryLimpio = texto
      .replace(/^(dr\.?|dra\.?|doctor|doctora|el\s+|la\s+)/gi, "")
      .trim();
    if (queryLimpio.length >= 2) {
      try {
        const res = await profesionalesRepo.buscarPorNombre(tenantId, queryLimpio, 8);
        matchesPorNombre = res.map(p => ({ id: p.id, prefijo: p.prefijo, nombre: p.nombre, apellido: p.apellido, especialidad: p.especialidad }));
      } catch (err) {
        logWarn(logCtx, "búsqueda por nombre falló", { err: String(err) });
        return null; // dejar al LLM
      }
    }
  }

  const matches = [...matchesPorTelefono, ...matchesPorExtension, ...matchesPorNombre];

  // 0 matches
  if (matches.length === 0) {
    logInfo(logCtx, `identificación sin matches para "${texto}"`);
    if (texto.length < 4) return null;
    return { effects: [fxSend({ kind: "text", text: M.doctorNoEncontrado(texto) })] };
  }

  // 1 match
  if (matches.length === 1) {
    const p = matches[0];
    const display = `${p.prefijo} ${p.nombre} ${p.apellido}`;
    logInfo(logCtx, `identificación: 1 match → ${display}`);
    return {
      effects: [fxSend({
        kind: "buttons",
        text: M.confirmarDoctorEncontrado(display, p.especialidad),
        buttons: M.opcionesConfirmarDoctor(p.id),
      })],
    };
  }

  // 2-8 matches
  logInfo(logCtx, `identificación: ${matches.length} matches`);
  return {
    effects: [fxSend({
      kind: "buttons",
      text: M.variosDoctoresEncontrados(),
      buttons: matches.slice(0, 8).map(p => ({
        label: `${p.prefijo} ${p.nombre} ${p.apellido}`,
        data: `agendar_con:${p.id}`,
      })),
    })],
  };
}
