// ================================================================
// dates.ts — Helpers de fechas. Toda la lógica de timezone en
// un solo lugar para no repetirla en cada ruta.
// ================================================================
import { ENV } from "./env.js";

/** Convierte un timestamp ISO (UTC) a hora local de RD. Ej: "8:00 AM" */
export function toLocalTime(isoUtc: string): string {
  return new Date(isoUtc).toLocaleTimeString("es-DO", {
    timeZone: ENV.TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Devuelve la fecha local "YYYY-MM-DD" a partir de un ISO UTC */
export function toLocalDate(isoUtc: string): string {
  return new Date(isoUtc).toLocaleDateString("en-CA", {
    timeZone: ENV.TIMEZONE,
  });
}

/** "Lun 15 Ene" */
export function formatDayLabel(isoUtc: string): string {
  const DIAS  = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
  const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  const dt = new Date(isoUtc);
  const dow = parseInt(dt.toLocaleDateString("en-US", { timeZone: ENV.TIMEZONE, weekday: "short" }).replace(/\D/g, ""), 10);
  const day = parseInt(dt.toLocaleDateString("en-CA", { timeZone: ENV.TIMEZONE }).split("-")[2]!, 10);
  const mon = parseInt(dt.toLocaleDateString("en-CA", { timeZone: ENV.TIMEZONE }).split("-")[1]!, 10) - 1;
  // toLocaleDateString weekday como número
  const d = new Date(dt.toLocaleDateString("en-CA", { timeZone: ENV.TIMEZONE }));
  return `${DIAS[d.getDay()]} ${day} ${MESES[mon]}`;
}

/** Convierte fecha local YYYY-MM-DD + hora 00:00 / 23:59 a ISO UTC */
export function localDateToUtcRange(fecha: string): { desde: string; hasta: string } {
  const tz = ENV.TIMEZONE;
  const desde = new Date(
    new Date(`${fecha}T00:00:00`).toLocaleString("en-US", { timeZone: tz })
  ).toISOString();
  const hasta = new Date(
    new Date(`${fecha}T23:59:59`).toLocaleString("en-US", { timeZone: tz })
  ).toISOString();
  return { desde, hasta };
}

/** Normaliza fecha ISO con o sin timezone. Si no tiene, asume RD. */
export function parseInicia(raw: string): { utc: string; localDt: Date } {
  let dt: Date;
  const tieneOffset = /T.*([+-]\d{2}:\d{2}|Z)$/.test(raw);
  if (tieneOffset) {
    dt = new Date(raw);
  } else {
    // Asumimos que es hora local de RD (mismo comportamiento que el PHP)
    const asLocal = new Date(raw + " GMT-0400");
    dt = asLocal;
  }
  return { utc: dt.toISOString(), localDt: dt };
}

/** ¿Es una fecha válida YYYY-MM-DD? */
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00");
  return !isNaN(d.getTime());
}

/** ¿Es un UUID v4 válido? */
export function isValidUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** Normaliza teléfono dominicano: 8091234567 → +18091234567 */
export function normalizeTelefono(tel: string): string {
  const clean = tel.replace(/[^0-9+]/g, "");
  if (/^[89]\d{9}$/.test(clean)) return "+1" + clean;
  return clean;
}
