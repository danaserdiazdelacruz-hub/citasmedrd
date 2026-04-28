// tests/unit/datetime.test.ts
// Tests del helper de fecha/hora con timezone.
// Verifica que NO depende de la TZ del proceso (Railway corre en UTC,
// el usuario está en Santo Domingo: -04:00).

import { describe, it, expect } from "vitest";
import {
  partsInTz,
  hoyISO,
  sumarDiasISO,
  diaSemanaDeISO,
  proximosDiasHabiles,
  formatFechaLarga,
  formatFechaHora,
  formatHoraCorta,
} from "../../src/domain/datetime.js";

const TZ_DO = "America/Santo_Domingo";  // UTC-4 sin DST

describe("partsInTz", () => {
  it("convierte instante UTC a partes en Santo Domingo", () => {
    // 2026-05-04T03:00:00Z → en Santo Domingo (UTC-4) son 23:00 del 3 de mayo
    const d = new Date("2026-05-04T03:00:00Z");
    const p = partsInTz(d, TZ_DO);
    expect(p.year).toBe(2026);
    expect(p.month).toBe(5);
    expect(p.day).toBe(3);
    expect(p.hour).toBe(23);
  });

  it("dayOfWeek está en rango 0..6", () => {
    const d = new Date("2026-05-04T12:00:00Z");
    const p = partsInTz(d, TZ_DO);
    expect(p.dayOfWeek).toBeGreaterThanOrEqual(0);
    expect(p.dayOfWeek).toBeLessThanOrEqual(6);
  });
});

describe("sumarDiasISO", () => {
  it("suma días al inicio del mes", () => {
    expect(sumarDiasISO("2026-05-01", 1)).toBe("2026-05-02");
  });

  it("cruza el mes", () => {
    expect(sumarDiasISO("2026-05-31", 1)).toBe("2026-06-01");
  });

  it("cruza el año", () => {
    expect(sumarDiasISO("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("año bisiesto", () => {
    expect(sumarDiasISO("2028-02-28", 1)).toBe("2028-02-29");
    expect(sumarDiasISO("2028-02-29", 1)).toBe("2028-03-01");
  });
});

describe("diaSemanaDeISO", () => {
  it("2026-05-04 es lunes (1)", () => {
    expect(diaSemanaDeISO("2026-05-04")).toBe(1);
  });
  it("2026-05-09 es sábado (6)", () => {
    expect(diaSemanaDeISO("2026-05-09")).toBe(6);
  });
});

describe("proximosDiasHabiles", () => {
  it("devuelve la cantidad pedida", () => {
    const dias = proximosDiasHabiles(5, TZ_DO);
    expect(dias.length).toBe(5);
  });

  it("nunca incluye sábado (6) ni domingo (0)", () => {
    const dias = proximosDiasHabiles(10, TZ_DO);
    for (const d of dias) {
      const dow = diaSemanaDeISO(d.iso);
      expect(dow).not.toBe(0);
      expect(dow).not.toBe(6);
    }
  });

  it("cada label tiene formato 'Lun 5 may'", () => {
    const dias = proximosDiasHabiles(3, TZ_DO);
    for (const d of dias) {
      expect(d.label).toMatch(/^(Lun|Mar|Mié|Jue|Vie) \d{1,2} (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)$/);
    }
  });
});

describe("formatFechaLarga", () => {
  it("formatea YYYY-MM-DD a 'lunes 4 de mayo'", () => {
    expect(formatFechaLarga("2026-05-04")).toBe("lunes 4 de mayo");
  });
});

describe("formatHoraCorta", () => {
  it("convierte ISO con offset a hora local del tenant", () => {
    // 12:00 PM en Santo Domingo es 16:00Z
    const iso = "2026-05-04T12:00:00-04:00";
    expect(formatHoraCorta(iso, TZ_DO)).toBe("12:00 PM");
  });

  it("medianoche es 12:00 AM", () => {
    const iso = "2026-05-04T00:00:00-04:00";
    expect(formatHoraCorta(iso, TZ_DO)).toBe("12:00 AM");
  });

  it("padding de minutos", () => {
    const iso = "2026-05-04T08:05:00-04:00";
    expect(formatHoraCorta(iso, TZ_DO)).toBe("8:05 AM");
  });
});

describe("formatFechaHora", () => {
  it("combina fecha larga + hora corta", () => {
    const iso = "2026-05-04T08:30:00-04:00";
    expect(formatFechaHora(iso, TZ_DO)).toBe("lunes 4 de mayo, 8:30 AM");
  });
});

describe("hoyISO", () => {
  it("devuelve un YYYY-MM-DD válido", () => {
    expect(hoyISO(TZ_DO)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
