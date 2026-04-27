// src/application/use-cases/reagendar-cita.ts
// Reagenda atómicamente. Si falla, la cita original NO se cancela.

import { citasRepo } from "../../persistence/repositories/index.js";

export interface ReagendarCitaInput {
  tenantId: string;
  citaId: string;
  nuevoIniciaEn: string;
  usuarioId?: string | null;
}

export interface ReagendarCitaResult {
  citaId: string;
  codigo: string;
}

export async function reagendarCita(input: ReagendarCitaInput): Promise<ReagendarCitaResult> {
  const result = await citasRepo.reagendar({
    tenantId: input.tenantId,
    citaId: input.citaId,
    nuevoIniciaEn: input.nuevoIniciaEn,
    usuarioId: input.usuarioId,
  });

  citasRepo.ensureSuccess(result);

  return {
    citaId: result.cita_id!,
    codigo: result.codigo!,
  };
}
