// src/application/config/resolver.ts
// Lectura de configuración por tenant y por profesional.
// Funciones puras sobre datos ya cargados — sin IO.

import type { Tenant } from "../../persistence/repositories/index.js";

export const ASISTENTE_NOMBRE_DEFAULT = "María Salud";
export const TZ_FALLBACK = "America/Santo_Domingo";

export function nombreAsistenteDe(tenant: Tenant | null): string {
  const v = tenant?.configuracion?.["asistente_nombre"];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return ASISTENTE_NOMBRE_DEFAULT;
}

export function faqDelTenant(tenant: Tenant | null): Record<string, unknown> | undefined {
  const raw = tenant?.configuracion?.["faq"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

export function faqDelProfesional(
  profesional: { configuracion?: Record<string, unknown> | null } | null,
  tenant: Tenant | null,
): Record<string, unknown> | undefined {
  const rawProf = profesional?.configuracion?.["faq"];
  if (rawProf && typeof rawProf === "object" && !Array.isArray(rawProf)) {
    return rawProf as Record<string, unknown>;
  }
  return faqDelTenant(tenant);
}

export function tzDe(tenant: Tenant | null): string {
  return tenant?.timezone ?? TZ_FALLBACK;
}
