// src/domain/validators/phone.ts
// Validación de teléfonos dominicanos.
// Normaliza a formato E.164 (+18094563214) que es lo que guardamos en DB.
// Puro. Sin IO. Testeable.

export interface PhoneValidationResult {
  valid: boolean;
  /** Formato E.164: "+18094563214" */
  normalized: string | null;
  /** Razón de rechazo (ninguna si valid=true) */
  reason?: string;
}

const DO_PREFIXES = ["809", "829", "849"] as const;

/**
 * Valida y normaliza un teléfono dominicano.
 *
 * Acepta:
 *   "8094563214"             → +18094563214
 *   "+18094563214"           → +18094563214
 *   "1-809-456-3214"         → +18094563214
 *   "(809) 456 3214"         → +18094563214
 *   "809.456.3214"           → +18094563214
 *
 * Rechaza:
 *   teléfonos con != 10 dígitos (sin contar el "1" de país)
 *   prefijos que no sean 809/829/849
 *   strings vacíos o no string
 */
export function validatePhoneDO(raw: unknown): PhoneValidationResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { valid: false, normalized: null, reason: "teléfono vacío" };
  }

  // Extraer solo dígitos
  let digits = raw.replace(/\D/g, "");

  // Si viene con el "1" de país (11 dígitos), quitarlo
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }

  if (digits.length !== 10) {
    return {
      valid: false,
      normalized: null,
      reason: `tiene ${digits.length} dígitos, se esperan 10`,
    };
  }

  const prefix = digits.slice(0, 3);
  if (!DO_PREFIXES.includes(prefix as (typeof DO_PREFIXES)[number])) {
    return {
      valid: false,
      normalized: null,
      reason: `prefijo ${prefix} no es dominicano (use 809/829/849)`,
    };
  }

  return { valid: true, normalized: "+1" + digits };
}

/**
 * Formatea un E.164 dominicano a display humano: "809-456-3214".
 * Útil para mostrar en la UI del bot.
 */
export function formatPhoneDO(e164: string): string {
  const match = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (!match) return e164;
  return `${match[1]}-${match[2]}-${match[3]}`;
}
