// src/domain/validators/name.ts
// Validación de nombre de paciente.
// Previene nombres basura ("rita bbb"), inyecciones, valores ambiguos.

export interface NameValidationResult {
  valid: boolean;
  nombre: string;
  apellido: string;
  reason?: string;
  /** true si Claude pidió nombre pero el usuario dio algo sospechoso; backend puede repreguntar */
  suspicious?: boolean;
}

// Apellidos genéricos que el LLM no debe aceptar como reales
const PROHIBIDOS_COMO_APELLIDO = new Set([
  "paciente", "usuario", "cliente", "persona",
  "user", "null", "undefined", "n/a", "na",
]);

// Patrones que delatan basura
const PATRON_SOSPECHOSO = /^[a-z]?(bbb|xxx|yyy|aaa|zzz|abc|test|prueba|asd|qwe)$/i;

// Solo letras (incluye acentos y ñ), espacios, apóstrofe, guión, punto
const CHARSET_VALIDO = /^[\p{L}\s'\-.]+$/u;

/**
 * Valida un nombre libre proveniente de texto del usuario.
 *
 * Separa nombre y apellido por el primer espacio.
 * El apellido puede ir vacío.
 */
export function validateName(raw: unknown): NameValidationResult {
  if (typeof raw !== "string") {
    return { valid: false, nombre: "", apellido: "", reason: "nombre vacío" };
  }

  // Limpiar: trim, caracteres de control out, colapsar espacios
  const clean = raw.trim()
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ");

  if (clean.length < 2) {
    return { valid: false, nombre: "", apellido: "", reason: "nombre muy corto" };
  }
  if (clean.length > 100) {
    return { valid: false, nombre: "", apellido: "", reason: "nombre muy largo" };
  }

  if (!CHARSET_VALIDO.test(clean)) {
    return { valid: false, nombre: "", apellido: "", reason: "caracteres inválidos" };
  }

  const partes = clean.split(" ");
  const nombre = partes[0];
  let apellido = partes.slice(1).join(" ");

  // Normalizar capitalización: Primera letra mayúscula de cada palabra
  const capitalizar = (s: string) =>
    s.split(" ").map(w =>
      w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()
    ).join(" ");

  const nombreNormalizado = capitalizar(nombre);
  let apellidoNormalizado = capitalizar(apellido);

  // Defensa: apellido prohibido → se descarta
  if (PROHIBIDOS_COMO_APELLIDO.has(apellidoNormalizado.toLowerCase())) {
    apellidoNormalizado = "";
  }

  // Defensa: apellido sospechoso → marcar pero permitir
  let suspicious = false;
  if (PATRON_SOSPECHOSO.test(apellidoNormalizado)) {
    apellidoNormalizado = "";
    suspicious = true;
  }
  if (PATRON_SOSPECHOSO.test(nombreNormalizado)) {
    return {
      valid: false,
      nombre: "",
      apellido: "",
      reason: "nombre parece no ser real",
      suspicious: true,
    };
  }

  return {
    valid: true,
    nombre: nombreNormalizado,
    apellido: apellidoNormalizado,
    suspicious,
  };
}
