// src/domain/validators/document-id.ts
// Validación de cédula dominicana usando el algoritmo de Luhn mod-10.
// Formato: 001-1234567-8 (11 dígitos, último es verificador).

export interface CedulaValidationResult {
  valid: boolean;
  /** Formato canónico: "001-1234567-8" */
  normalized: string | null;
  reason?: string;
}

/**
 * Valida una cédula dominicana.
 *
 * El algoritmo:
 *   - 11 dígitos
 *   - Multiplicadores [1,2,1,2,1,2,1,2,1,2] en los primeros 10 dígitos
 *   - Si producto ≥ 10, sumar sus dígitos
 *   - Suma total mod 10 → complemento a 10 debe igualar el dígito 11
 */
export function validateCedulaDO(raw: unknown): CedulaValidationResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { valid: false, normalized: null, reason: "cédula vacía" };
  }

  const digits = raw.replace(/\D/g, "");

  if (digits.length !== 11) {
    return {
      valid: false,
      normalized: null,
      reason: `tiene ${digits.length} dígitos, se esperan 11`,
    };
  }

  const multipliers = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  let sum = 0;

  for (let i = 0; i < 10; i++) {
    let product = Number(digits[i]) * multipliers[i];
    if (product >= 10) product = Math.floor(product / 10) + (product % 10);
    sum += product;
  }

  const expected = (10 - (sum % 10)) % 10;
  const actual = Number(digits[10]);

  if (expected !== actual) {
    return {
      valid: false,
      normalized: null,
      reason: "dígito verificador incorrecto",
    };
  }

  return {
    valid: true,
    normalized: `${digits.slice(0, 3)}-${digits.slice(3, 10)}-${digits.slice(10)}`,
  };
}
