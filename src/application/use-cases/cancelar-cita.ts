// src/application/use-cases/cancelar-cita.ts
// Cancela una cita existente. Lanza DomainError si no se puede.

import { citasRepo } from "../../persistence/repositories/index.js";

export interface CancelarCitaInput {
  tenantId: string;
  citaId: string;
  motivo?: string | null;
  usuarioId?: string | null;
}

export async function cancelarCita(input: CancelarCitaInput): Promise<void> {
  const result = await citasRepo.cancelar({
    tenantId: input.tenantId,
    citaId: input.citaId,
    motivo: input.motivo,
    usuarioId: input.usuarioId,
  });

  citasRepo.ensureSuccess(result);
}
