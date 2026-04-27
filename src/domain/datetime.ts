// src/domain/datetime.ts
// Utilidades puras de fecha/hora con conciencia de timezone.
// Reemplaza el uso ingenuo de `new Date()` y `toISOString().slice(0,10)`
// que en Railway (UTC) calculaba "mañana" mal para usuarios en Santo Domingo.
//
// Sin IO. Sin libs externas. Usa Intl.DateTimeFormat (built-in en Node 22+).

const DIAS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const DIAS_CORTO = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const MESES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "octubre", "noviembre", "diciembre"];
const MESES_CORTO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/**
 * Devuelve los componentes de fecha/hora de `instant` en `tz`.
 * Útil para saber "qué día es para el usuario" sin importar dónde corra el server.
 */
export function partsInTz(instant: Date, tz: string): {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  dayOfWeek: number; // 0=domingo .. 6=sábado
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, weekday: "short",
  });
  const partsRaw = fmt.formatToParts(instant);
  const get = (t: string) => partsRaw.find(p => p.type === t)?.value ?? "0";

  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const wk = partsRaw.find(p => p.type === "weekday")?.value ?? "Sun";
  // En 'en-CA' la hora 24 puede aparecer como "24" — normalizar a 0
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;

  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour,
    minute: parseInt(get("minute"), 10),
    second: parseInt(get("second"), 10),
    dayOfWeek: weekdayMap[wk] ?? 0,
  };
}

/** ISO YYYY-MM-DD del día actual en la timezone dada. */
export function hoyISO(tz: string): string {
  const p = partsInTz(new Date(), tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * Suma `dias` calendario a una fecha YYYY-MM-DD.
 * Operación pura sobre el string ISO (no depende de TZ del server porque no usa Date.UTC con TZ).
 */
export function sumarDiasISO(fechaISO: string, dias: number): string {
  const [y, m, d] = fechaISO.split("-").map(n => parseInt(n, 10));
  // Usamos UTC para la aritmética pero solo nos importan las componentes Y-M-D, no la hora
  const t = Date.UTC(y, m - 1, d) + dias * 86400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** Día de la semana (0..6) para un YYYY-MM-DD. */
export function diaSemanaDeISO(fechaISO: string): number {
  const [y, m, d] = fechaISO.split("-").map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Genera los próximos N días hábiles (lunes-viernes) a partir de `ahora` en `tz`.
 * Empieza desde MAÑANA en la timezone del tenant, no del server.
 */
export function proximosDiasHabiles(cantidad: number, tz: string): Array<{ iso: string; label: string }> {
  const result: Array<{ iso: string; label: string }> = [];
  let cursor = sumarDiasISO(hoyISO(tz), 1);
  // Hard limit defensivo: no iterar más de 30 días para encontrar `cantidad`
  let safety = 30;
  while (result.length < cantidad && safety-- > 0) {
    const dow = diaSemanaDeISO(cursor);
    if (dow !== 0 && dow !== 6) {
      const [, m, d] = cursor.split("-").map(n => parseInt(n, 10));
      result.push({
        iso: cursor,
        label: `${DIAS_CORTO[dow]} ${d} ${MESES_CORTO[m - 1]}`,
      });
    }
    cursor = sumarDiasISO(cursor, 1);
  }
  return result;
}

/** Para mostrar al usuario: "lunes 5 de mayo". */
export function formatFechaLarga(fechaISO: string): string {
  const dow = diaSemanaDeISO(fechaISO);
  const [, m, d] = fechaISO.split("-").map(n => parseInt(n, 10));
  return `${DIAS_ES[dow]} ${d} de ${MESES_ES[m - 1]}`;
}

/**
 * Para mostrar al usuario: "lunes 5 de mayo, 8:00 AM" en la timezone del tenant.
 * `iniciaEnIso` es lo que devuelve la DB (ISO con offset).
 */
export function formatFechaHora(iniciaEnIso: string, tz: string): string {
  const d = new Date(iniciaEnIso);
  const p = partsInTz(d, tz);
  const fechaISO = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const fecha = formatFechaLarga(fechaISO);
  const ampm = p.hour >= 12 ? "PM" : "AM";
  const h12 = p.hour % 12 || 12;
  const mm = String(p.minute).padStart(2, "0");
  return `${fecha}, ${h12}:${mm} ${ampm}`;
}

/** Para botón de slot: "8:00 AM" en la timezone del tenant. */
export function formatHoraCorta(iniciaEnIso: string, tz: string): string {
  const d = new Date(iniciaEnIso);
  const p = partsInTz(d, tz);
  const ampm = p.hour >= 12 ? "PM" : "AM";
  const h12 = p.hour % 12 || 12;
  const mm = String(p.minute).padStart(2, "0");
  return `${h12}:${mm} ${ampm}`;
}
