// src/domain/historial.ts
// Sanitización del historial conversacional para pasarlo al LLM.
// Pura, sin IO, sin imports de DB. Testeable aislado.
//
// La sesión guarda hasta 20 turnos en `historial` (jsonb append atómico).
// Cuando llamamos al LLM, le pasamos los últimos N para que recuerde el
// contexto reciente. Pero la DB acepta cualquier string en `role`, así que
// hay que filtrar/normalizar antes de mandar.

export interface LLMTurnLite {
  role: "user" | "assistant";
  content: string;
}

const MAX_TURNOS_LLM = 10;

/**
 * Reglas:
 *   - role debe ser exactamente "user" o "assistant"
 *   - content debe ser string no vacío
 *   - se elimina el último turno del usuario si coincide con el mensaje actual
 *     (evita duplicado: callLLM ya agrega userMessage al final)
 *   - se descarta cualquier "assistant" al inicio (Anthropic exige que la
 *     conversación arranque con role=user)
 *   - límite de 10 turnos para no inflar tokens
 *
 * Si el historial está mal formado, devuelve [] silenciosamente.
 */
export function extraerHistorialParaLLM(
  historialRaw: unknown,
  mensajeActualUsuario: string,
): LLMTurnLite[] {
  if (!Array.isArray(historialRaw)) return [];

  const sanitizado: LLMTurnLite[] = [];
  for (const t of historialRaw) {
    if (!t || typeof t !== "object") continue;
    const role = (t as { role?: unknown }).role;
    const content = (t as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || content.trim().length === 0) continue;
    sanitizado.push({ role, content });
  }

  // Si el último turno es del usuario y coincide con el mensaje actual,
  // lo eliminamos (callLLM ya lo agrega como userMessage al final).
  if (sanitizado.length > 0) {
    const ultimo = sanitizado[sanitizado.length - 1];
    if (ultimo.role === "user" && ultimo.content.trim() === mensajeActualUsuario.trim()) {
      sanitizado.pop();
    }
  }

  // Anthropic requiere que la conversación NO empiece con "assistant".
  while (sanitizado.length > 0 && sanitizado[0].role !== "user") {
    sanitizado.shift();
  }

  return sanitizado.slice(-MAX_TURNOS_LLM);
}
