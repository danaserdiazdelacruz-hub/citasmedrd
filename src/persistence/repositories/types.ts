// src/persistence/repositories/types.ts
// Tipos compartidos por todos los repositorios.
// Reflejan exactamente lo que devuelven las funciones RPC del schema 002.

import type { ErrorCode } from "../../domain/errors.js";

/**
 * Resultado estándar de toda función RPC del sistema.
 * Sincronizado con CATÁLOGO OFICIAL de error_code en 002_funciones.sql.
 */
export interface RpcResult {
  success: boolean;
  error_code: ErrorCode | null;
  error_message: string | null;
}

export interface AgendarResult extends RpcResult {
  cita_id: string | null;
  codigo: string | null;
}

export interface ReagendarResult extends AgendarResult {}

export interface CancelarResult extends RpcResult {}

export interface PacienteResult {
  paciente_id: string;
  creado: boolean;
}

export interface HorarioLibre {
  inicia_en: string;     // ISO timestamp con TZ
  cupos_libres: number;
}

export type CanalOrigen =
  | "whatsapp"
  | "instagram"
  | "facebook"
  | "web"
  | "telegram"
  | "dashboard"
  | "api";

export type TipoPago =
  | "efectivo"
  | "seguro"
  | "tarjeta"
  | "transferencia"
  | "mixto";
