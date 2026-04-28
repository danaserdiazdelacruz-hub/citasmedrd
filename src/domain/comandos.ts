// src/domain/comandos.ts
// Detección de comandos de slash escritos como texto (no entity de Telegram).
// Pura, sin IO, testeable aislada.
//
// Cubre el caso real: usuario escribe /Star (con mayúscula y typo) y Telegram
// no lo registra como bot_command. Antes el bot decía "no entendí". Ahora lo
// interpretamos y respondemos correctamente.

/**
 * Solo reconoce variaciones de los comandos que el orquestador soporta:
 *   start, menu, cancelar, salir
 *
 * Devuelve el comando normalizado (lowercase) o null si no aplica.
 *
 * Tolera typos comunes:
 *   /Star, /Starts, /START → "start"
 *   /Menú, /Menu, /menus → "menu"
 *   /Cancela, /Cancelar → "cancelar"
 */
export function textoComoComando(texto: string): string | null {
  if (typeof texto !== "string") return null;
  const t = texto.trim().toLowerCase();
  if (!t.startsWith("/")) return null;

  // Si tiene más de 20 chars probablemente no es un comando sino texto
  // que casualmente empieza con "/".
  if (t.length > 20) return null;

  // Quitar el slash y eventualmente el @nombrebot
  const cuerpo = t.slice(1).split("@")[0].trim();
  if (cuerpo.length === 0) return null;

  // Match con tolerancia: empieza con la raíz del comando.
  if (cuerpo.startsWith("star") || cuerpo === "inicio" || cuerpo === "comenzar") return "start";
  if (cuerpo.startsWith("men")) return "menu";
  if (cuerpo.startsWith("cancel") || cuerpo === "salir") return "cancelar";

  return null;
}
