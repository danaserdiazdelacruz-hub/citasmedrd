// src/application/dispatcher/guards.ts
// Clasificadores de input. Funciones PURAS: string → boolean.
// Sin imports de infraestructura. Testeables con tabla de verdad.
// Se ejecutan ANTES de que el FSM dispatcher decida a dónde va el mensaje.

// ─── Cancelación universal ────────────────────────────────────────────

const PALABRAS_CANCELAR = [
  "cancela", "cancelar", "cancelado", "cancelalo", "cancélalo",
  "olvida", "olvídalo", "olvidalo", "olvida eso", "ya no quiero",
  "no quiero", "déjalo", "dejalo", "salir", "salida", "atrás",
  "atras", "regresar", "volver al menú", "volver al menu",
  "menu", "menú", "inicio", "stop", "detente", "para",
];

export function quiereCancelar(texto: string): boolean {
  const limpio = texto.toLowerCase().trim();
  if (limpio.length === 0) return false;
  return PALABRAS_CANCELAR.some(p => limpio === p || limpio.includes(p));
}

// ─── Cortesía / cierre conversacional ────────────────────────────────

const PALABRAS_CORTESIA = [
  "gracias", "muchas gracias", "thank you", "thanks", "ty",
  "ok", "okay", "okey", "vale", "perfecto", "listo", "bien",
  "genial", "genial!", "excelente", "chevere", "chévere",
  "super", "súper", "increible", "increíble", "wow", "nice",
  "entendido", "claro", "de acuerdo", "dale", "hecho",
  "👍", "🙏", "✅", "👌", "🎉", "💯",
];

export function esCortesia(texto: string): boolean {
  const limpio = texto.toLowerCase().trim().replace(/[!.?¡¿]/g, "");
  if (limpio.length === 0 || limpio.length > 30) return false;
  return PALABRAS_CORTESIA.some(p => limpio === p || limpio === `${p}!`);
}

// ─── Saludo / small talk ──────────────────────────────────────────────

const PALABRAS_SALUDO = [
  "hola", "holaa", "holaaa", "hi", "hello", "buenas", "buenos dias",
  "buenas tardes", "buenas noches", "buen dia", "saludos", "que tal",
  "hey", "ola", "wenas",
];

export function esSaludo(texto: string): boolean {
  const limpio = texto.toLowerCase().trim().replace(/[!.?¡¿,]/g, "");
  if (limpio.length === 0 || limpio.length > 25) return false;
  return PALABRAS_SALUDO.some(p => limpio === p || limpio.startsWith(`${p} `));
}

// ─── Intención general (info / ayuda / pregunta) ──────────────────────
// Si el texto contiene estas pistas, el LLM debe manejarlo, no la búsqueda de doctor.

const PISTAS_INTENCION_GENERAL = [
  "ayuda", "ayudar", "informacion", "información", "info", "consulta",
  "pregunta", "duda", "como ", "cómo ", "que es", "qué es", "donde",
  "dónde", "cuanto", "cuánto", "horario", "ubicacion", "ubicación",
  "direccion", "dirección", "precio", "costo", "seguro", "ars",
  "atienden", "tienen", "ofrecen", "trabajan",
  "cancelar", "anular", "ver mis", "mis citas", "mi cita",
  "no se", "no sé", "no estoy",
];

export function pareceIntencionGeneralNoBusqueda(texto: string): boolean {
  const limpio = texto.toLowerCase().trim();
  if (limpio.length === 0) return false;
  return PISTAS_INTENCION_GENERAL.some(p => limpio.includes(p));
}

// ─── Intención de gestionar cita (cancelar / consultar) en IDLE ───────
// Detecta frases como "me gustaría cancelar", "quiero ver mis citas",
// "tengo una cita que cancelar", etc.
// Más específico que quiereCancelar — este solo aplica en IDLE.

const PISTAS_CANCELAR_CITA = [
  "cancelar", "cancelarla", "cancelarlo", "anular", "quitar la cita",
  "me gustaría cancelar", "quisiera cancelar", "quiero cancelar",
  "necesito cancelar", "tengo que cancelar",
];

const PISTAS_CONSULTAR_CITA = [
  "ver mis citas", "ver mi cita", "mis citas", "mi cita",
  "tengo cita", "tengo una cita", "consultar cita",
  "citas activas", "cita activa", "cita pendiente",
  "cuando es mi cita", "cuándo es mi cita",
];

export function quiereGestionarCita(
  texto: string,
  intencion: "cancelar" | "consultar",
): boolean {
  const limpio = texto.toLowerCase().trim();
  if (limpio.length === 0) return false;
  const pistas = intencion === "cancelar" ? PISTAS_CANCELAR_CITA : PISTAS_CONSULTAR_CITA;
  return pistas.some(p => limpio.includes(p));
}
// Heurística: ¿tiene sentido intentar buscar un profesional con este texto?

export function pareceBusquedaDeDoctor(texto: string): boolean {
  const limpio = texto.trim();
  if (limpio.length < 3 || limpio.length > 60) return false;
  if (esSaludo(limpio)) return false;
  if (esCortesia(limpio)) return false;
  if (pareceIntencionGeneralNoBusqueda(limpio)) return false;

  // Solo dígitos (con separadores): teléfono o extensión
  const soloDigitos = limpio.replace(/[\s\-().+]/g, "");
  if (/^\d+$/.test(soloDigitos)) return true;

  // Tiene secuencia de letras ≥ 3: probablemente nombre/apellido
  return /[a-záéíóúñ]{3,}/i.test(limpio);
}
