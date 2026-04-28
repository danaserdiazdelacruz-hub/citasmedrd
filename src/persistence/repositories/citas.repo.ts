// src/persistence/repositories/citas.repo.ts
// Único punto de acceso a las funciones RPC de citas.
// Wrapper sobre fn_agendar, fn_cancelar, fn_reagendar, fn_horarios_libres.
//
// Reglas:
//   - Nadie fuera de este archivo llama esas RPCs.
//   - Cada método devuelve datos tipados; los errores de DB se traducen a DomainError.
//   - El caller decide si lanza la excepción o maneja success=false.

import { rpc } from "../db.js";
import { DomainError, isErrorCode } from "../../domain/errors.js";
import type {
  AgendarResult,
  CancelarResult,
  ReagendarResult,
  HorarioLibre,
  CanalOrigen,
  TipoPago,
} from "./types.js";

export interface AgendarInput {
  tenantId: string;
  profesionalSedeId: string;
  pacienteId: string;
  servicioId: string;
  iniciaEn: string;                    // ISO con offset, ej: "2026-05-04T08:00:00-04:00"
  canalOrigen: CanalOrigen;
  motivoVisita?: string | null;
  aseguradoraId?: string | null;
  creadoPorUsuarioId?: string | null;
  tipoPago?: TipoPago;                 // default 'efectivo'
}

export interface CancelarInput {
  tenantId: string;
  citaId: string;
  motivo?: string | null;
  usuarioId?: string | null;
}

export interface ReagendarInput {
  tenantId: string;
  citaId: string;
  nuevoIniciaEn: string;
  usuarioId?: string | null;
}

export interface ListarHorariosInput {
  profesionalSedeId: string;
  fecha: string;                       // YYYY-MM-DD
}

class CitasRepo {
  async agendar(input: AgendarInput): Promise<AgendarResult> {
    const { data, error } = await rpc<AgendarResult>("fn_agendar", {
      p_tenant_id: input.tenantId,
      p_profesional_sede_id: input.profesionalSedeId,
      p_paciente_id: input.pacienteId,
      p_servicio_id: input.servicioId,
      p_inicia_en: input.iniciaEn,
      p_canal_origen: input.canalOrigen,
      p_motivo_visita: input.motivoVisita ?? null,
      p_aseguradora_id: input.aseguradoraId ?? null,
      p_creado_por_usuario_id: input.creadoPorUsuarioId ?? null,
      p_tipo_pago: input.tipoPago ?? "efectivo",
    });

    if (error) throw new DomainError("DB_ERROR", error.message);
    if (!data || data.length === 0) {
      throw new DomainError("UNKNOWN", "fn_agendar no devolvió filas");
    }
    return data[0];
  }

  async cancelar(input: CancelarInput): Promise<CancelarResult> {
    const { data, error } = await rpc<CancelarResult>("fn_cancelar", {
      p_tenant_id: input.tenantId,
      p_cita_id: input.citaId,
      p_motivo: input.motivo ?? null,
      p_usuario_id: input.usuarioId ?? null,
    });

    if (error) throw new DomainError("DB_ERROR", error.message);
    if (!data || data.length === 0) {
      throw new DomainError("UNKNOWN", "fn_cancelar no devolvió filas");
    }
    return data[0];
  }

  async reagendar(input: ReagendarInput): Promise<ReagendarResult> {
    const { data, error } = await rpc<ReagendarResult>("fn_reagendar", {
      p_tenant_id: input.tenantId,
      p_cita_id: input.citaId,
      p_nuevo_inicia_en: input.nuevoIniciaEn,
      p_usuario_id: input.usuarioId ?? null,
    });

    if (error) throw new DomainError("DB_ERROR", error.message);
    if (!data || data.length === 0) {
      throw new DomainError("UNKNOWN", "fn_reagendar no devolvió filas");
    }
    return data[0];
  }

  async listarHorariosLibres(input: ListarHorariosInput): Promise<HorarioLibre[]> {
    const { data, error } = await rpc<HorarioLibre>("fn_horarios_libres", {
      p_profesional_sede_id: input.profesionalSedeId,
      p_fecha: input.fecha,
    });

    if (error) throw new DomainError("DB_ERROR", error.message);
    return data ?? [];
  }

  /**
   * Helper que lanza DomainError si la operación no fue exitosa.
   * Útil cuando el caller prefiere try/catch en vez de chequear success.
   */
  ensureSuccess<T extends { success: boolean; error_code: string | null; error_message: string | null }>(
    result: T
  ): T {
    if (result.success) return result;
    const code = isErrorCode(result.error_code) ? result.error_code : "UNKNOWN";
    throw new DomainError(code, result.error_message ?? undefined);
  }
}

export const citasRepo = new CitasRepo();
