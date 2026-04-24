// src/domain/errors.ts
// Catálogo OFICIAL de error_codes del sistema.
// Debe estar 1:1 con los códigos que devuelven las funciones SQL de la DB.
// Si la DB agrega un código nuevo, se agrega aquí. Si falta, TypeScript se queja.
//
// Tres responsabilidades:
//   1. Tipar los error_codes que vienen de la DB
//   2. Mapear cada código a mensaje UX amigable
//   3. Distinguir errores "retryable" (puede volver a intentar) vs "fatal"

/**
 * Catálogo cerrado. Si la DB devuelve un código que no está aquí, es un bug.
 * Sincronizado con 002_funciones.sql sección "CATÁLOGO OFICIAL DE error_code".
 */
export const ERROR_CODES = {
  OK: "OK",
  // Reservas / agendar
  SLOT_FULL: "SLOT_FULL",
  OUT_OF_HOURS: "OUT_OF_HOURS",
  DAY_BLOCKED: "DAY_BLOCKED",
  TIME_BLOCKED: "TIME_BLOCKED",
  PAST_TIME: "PAST_TIME",
  TOO_FAR_AHEAD: "TOO_FAR_AHEAD",
  DUPLICATE_BOOKING: "DUPLICATE_BOOKING",
  MISALIGNED_SLOT: "MISALIGNED_SLOT",
  // Estado
  NOT_FOUND: "NOT_FOUND",
  INVALID_STATE: "INVALID_STATE",
  CANCEL_WINDOW_CLOSED: "CANCEL_WINDOW_CLOSED",
  // Tenant
  TENANT_INACTIVE: "TENANT_INACTIVE",
  // Validación local (no viene de DB, la pone el backend)
  INVALID_PHONE: "INVALID_PHONE",
  INVALID_NAME: "INVALID_NAME",
  INVALID_INPUT: "INVALID_INPUT",
  // Infra / inesperados
  DB_ERROR: "DB_ERROR",
  UNKNOWN: "UNKNOWN",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Mensajes UX por defecto. El channel adapter puede sobrescribir para localización
 * o tono (ej. más formal para dashboard, más conversacional para bot).
 */
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  OK: "",
  SLOT_FULL: "Ese horario ya no tiene cupo. Tengo otras opciones disponibles.",
  OUT_OF_HOURS: "El profesional no atiende en ese horario.",
  DAY_BLOCKED: "El profesional no atiende ese día.",
  TIME_BLOCKED: "Ese rango horario no está disponible.",
  PAST_TIME: "No se puede agendar en una fecha pasada.",
  TOO_FAR_AHEAD: "No se puede reservar con tanta anticipación.",
  DUPLICATE_BOOKING: "Ya tiene una cita activa en ese horario.",
  MISALIGNED_SLOT: "El horario no es válido para este profesional.",
  NOT_FOUND: "No se encontró el recurso solicitado.",
  INVALID_STATE: "La operación no es válida en el estado actual de la cita.",
  CANCEL_WINDOW_CLOSED: "La ventana de cancelación gratuita ya cerró.",
  TENANT_INACTIVE: "El consultorio no está activo actualmente.",
  INVALID_PHONE: "El número de teléfono no es válido.",
  INVALID_NAME: "El nombre ingresado no es válido.",
  INVALID_INPUT: "Los datos ingresados no son válidos.",
  DB_ERROR: "Ocurrió un problema técnico. Intente de nuevo.",
  UNKNOWN: "Ocurrió un error inesperado.",
};

/** Códigos donde retry automático puede resolver. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "SLOT_FULL",       // la UI debería re-consultar horarios y ofrecer otra
  "DB_ERROR",        // problema transitorio
  "UNKNOWN",
]);

/** Códigos que representan que el usuario debe corregir su input. */
const USER_CORRECTABLE: ReadonlySet<ErrorCode> = new Set([
  "INVALID_PHONE",
  "INVALID_NAME",
  "INVALID_INPUT",
  "PAST_TIME",
  "TOO_FAR_AHEAD",
  "DUPLICATE_BOOKING",
]);

/** Clase de error del dominio. Mantiene el código original para routing. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? DEFAULT_MESSAGES[code] ?? "Error");
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }

  isRetryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  isUserCorrectable(): boolean {
    return USER_CORRECTABLE.has(this.code);
  }

  toJSON() {
    return {
      error_code: this.code,
      error_message: this.message,
      retryable: this.isRetryable(),
      user_correctable: this.isUserCorrectable(),
      details: this.details,
    };
  }
}

/** Traduce un error_code a mensaje UX. Usa override si viene, si no default. */
export function messageFor(code: ErrorCode, override?: string | null): string {
  return override?.trim() || DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES.UNKNOWN;
}

/** Valida que un string desconocido sea un ErrorCode válido. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && value in ERROR_CODES;
}

/** Convierte un resultado RPC en DomainError si no tuvo éxito. Utilidad para los repositorios. */
export function throwIfFailed(result: {
  success: boolean;
  error_code?: string | null;
  error_message?: string | null;
}): void {
  if (result.success) return;
  const code: ErrorCode = isErrorCode(result.error_code) ? result.error_code : "UNKNOWN";
  throw new DomainError(code, result.error_message ?? undefined);
}
