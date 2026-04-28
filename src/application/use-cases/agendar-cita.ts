// src/application/use-cases/agendar-cita.ts
// Caso de uso: agendar una cita.
// Orquesta validación + paciente + RPC + retorno tipado.
//
// El bot/dashboard no llama directo a citasRepo.agendar() — pasa por aquí.
// Aquí viven las validaciones de input, el get-or-create del paciente,
// y la traducción de errores RPC a DomainError tipados.

import { citasRepo, pacientesRepo } from "../../persistence/repositories/index.js";
import type { CanalOrigen, TipoPago } from "../../persistence/repositories/index.js";
import { validatePhoneDO, validateName } from "../../domain/validators/index.js";
import { DomainError } from "../../domain/errors.js";

export interface AgendarCitaInput {
  tenantId: string;
  profesionalSedeId: string;
  servicioId: string;
  iniciaEn: string;                    // ISO con offset
  canalOrigen: CanalOrigen;

  // Datos del paciente (puede ser nuevo o existente)
  pacienteTelefono: string;            // raw, se valida y normaliza
  pacienteNombre: string;
  pacienteApellido?: string;

  // Pago
  tipoPago?: TipoPago;
  aseguradoraId?: string | null;

  // Opcionales
  motivoVisita?: string | null;
  creadoPorUsuarioId?: string | null;
}

export interface AgendarCitaResult {
  citaId: string;
  codigo: string;
  pacienteId: string;
  pacienteCreado: boolean;             // true si era paciente nuevo
}

export async function agendarCita(input: AgendarCitaInput): Promise<AgendarCitaResult> {
  // 1. Validar teléfono → E.164
  const phone = validatePhoneDO(input.pacienteTelefono);
  if (!phone.valid || !phone.normalized) {
    throw new DomainError("INVALID_PHONE", phone.reason ?? "teléfono inválido");
  }

  // 2. Validar nombre
  const nameVal = validateName(`${input.pacienteNombre} ${input.pacienteApellido ?? ""}`.trim());
  if (!nameVal.valid) {
    throw new DomainError("INVALID_NAME", nameVal.reason ?? "nombre inválido");
  }

  // 3. Get-or-create paciente
  const paciente = await pacientesRepo.getOrCreate({
    tenantId: input.tenantId,
    telefono: phone.normalized,
    nombre: nameVal.nombre,
    apellido: nameVal.apellido,
  });

  // 4. Llamar fn_agendar (atómica, controla concurrencia)
  const result = await citasRepo.agendar({
    tenantId: input.tenantId,
    profesionalSedeId: input.profesionalSedeId,
    pacienteId: paciente.paciente_id,
    servicioId: input.servicioId,
    iniciaEn: input.iniciaEn,
    canalOrigen: input.canalOrigen,
    motivoVisita: input.motivoVisita,
    aseguradoraId: input.aseguradoraId,
    creadoPorUsuarioId: input.creadoPorUsuarioId,
    tipoPago: input.tipoPago ?? "efectivo",
  });

  // 5. Traducir error_code a DomainError si falló
  citasRepo.ensureSuccess(result);

  return {
    citaId: result.cita_id!,
    codigo: result.codigo!,
    pacienteId: paciente.paciente_id,
    pacienteCreado: paciente.creado,
  };
}
