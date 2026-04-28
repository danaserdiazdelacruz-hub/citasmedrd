// src/domain/horarios.ts
// Resumen legible de horarios de atención.
// Pura, sin IO, sin imports de DB. Testeable aislado.

const DIA_NOMBRE_CORTO = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

export interface HorarioAtencionRaw {
  dia_semana: number;          // 0 dom .. 6 sáb
  hora_inicio: string;         // "HH:MM:SS"
  hora_fin: string;
  tiene_pausa: boolean;
  pausa_inicio: string | null;
  pausa_fin: string | null;
}

/**
 * Convierte una lista de filas de `horarios_atencion` en líneas de texto
 * legibles agrupando los días que comparten la misma franja.
 *
 * Ejemplos:
 *   [L 8-12, M 8-12, V 8-12]                    → ["Lun, Mar, Vie: 08:00-12:00"]
 *   [L 8-17 con pausa 12-14, M 8-17 misma pausa] → ["Lun, Mar: 08:00-12:00, 14:00-17:00"]
 *   []                                          → []
 *
 * No hace asunciones sobre el orden de entrada. La función:
 *   - Toma cada horario con su franja única (incluyendo pausas)
 *   - Agrupa los días con la misma franja exacta
 *   - Devuelve una línea por grupo, con días en orden Dom-Sáb
 */
export function resumirHorariosAtencion(horarios: HorarioAtencionRaw[]): string[] {
  if (!horarios || horarios.length === 0) return [];

  const hhmm = (s: string): string => s.slice(0, 5);

  const grupos = new Map<string, number[]>();
  for (const h of horarios) {
    const franja = h.tiene_pausa && h.pausa_inicio && h.pausa_fin
      ? `${hhmm(h.hora_inicio)}-${hhmm(h.pausa_inicio)}, ${hhmm(h.pausa_fin)}-${hhmm(h.hora_fin)}`
      : `${hhmm(h.hora_inicio)}-${hhmm(h.hora_fin)}`;
    const arr = grupos.get(franja) ?? [];
    arr.push(h.dia_semana);
    grupos.set(franja, arr);
  }

  const resultado: string[] = [];
  for (const [franja, dias] of grupos) {
    const diasOrdenados = [...new Set(dias)].sort((a, b) => a - b);
    const nombresDias = diasOrdenados.map(d => DIA_NOMBRE_CORTO[d] ?? `Día${d}`).join(", ");
    resultado.push(`${nombresDias}: ${franja}`);
  }
  return resultado;
}
