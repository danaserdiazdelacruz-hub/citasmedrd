// src/domain/validators/email.ts
// Validación simple pero correcta de email.
// No intenta implementar RFC 5321 completo — las reglas prácticas bastan.

export interface EmailValidationResult {
  valid: boolean;
  /** Lowercase, trimmed */
  normalized: string | null;
  reason?: string;
}

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function validateEmail(raw: unknown): EmailValidationResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { valid: false, normalized: null, reason: "email vacío" };
  }

  const clean = raw.trim().toLowerCase();

  if (clean.length > 254) {
    return { valid: false, normalized: null, reason: "email demasiado largo" };
  }

  if (!EMAIL_REGEX.test(clean)) {
    return { valid: false, normalized: null, reason: "formato inválido" };
  }

  return { valid: true, normalized: clean };
}
