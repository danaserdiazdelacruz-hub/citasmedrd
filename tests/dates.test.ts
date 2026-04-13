// ================================================================
// dates.test.ts — Tests de los helpers de fechas y validaciones.
// Estos corren sin necesitar internet ni Supabase.
// ================================================================
import { describe, it, expect } from "vitest";
import { isValidDate, isValidUUID, normalizeTelefono, parseInicia } from "../src/lib/dates.js";

describe("isValidDate", () => {
  it("acepta fecha válida", () => {
    expect(isValidDate("2025-03-15")).toBe(true);
  });
  it("rechaza formato incorrecto", () => {
    expect(isValidDate("15-03-2025")).toBe(false);
    expect(isValidDate("2025/03/15")).toBe(false);
    expect(isValidDate("hola")).toBe(false);
  });
  it("rechaza fecha imposible", () => {
    expect(isValidDate("2025-02-30")).toBe(false);
    expect(isValidDate("2025-13-01")).toBe(false);
  });
});

describe("isValidUUID", () => {
  it("acepta UUID válido", () => {
    expect(isValidUUID("de3198c7-f29c-43ef-9d45-d86b1d3ece2b")).toBe(true);
  });
  it("rechaza cadenas inválidas", () => {
    expect(isValidUUID("no-es-uuid")).toBe(false);
    expect(isValidUUID("")).toBe(false);
    expect(isValidUUID("de3198c7f29c43ef9d45d86b1d3ece2b")).toBe(false); // sin guiones
  });
});

describe("normalizeTelefono", () => {
  it("agrega +1 a números dominicanos de 10 dígitos", () => {
    expect(normalizeTelefono("8091234567")).toBe("+18091234567");
    expect(normalizeTelefono("9091234567")).toBe("+19091234567");
  });
  it("limpia caracteres no numéricos", () => {
    expect(normalizeTelefono("(809) 123-4567")).toBe("+18091234567");
    expect(normalizeTelefono("809.123.4567")).toBe("+18091234567");
  });
  it("no toca números que ya tienen formato internacional", () => {
    expect(normalizeTelefono("+18091234567")).toBe("+18091234567");
  });
});

describe("parseInicia", () => {
  it("parsea ISO con offset sin error", () => {
    const { utc } = parseInicia("2025-03-15T10:00:00-04:00");
    expect(utc).toBe("2025-03-15T14:00:00.000Z");
  });
  it("parsea ISO con Z", () => {
    const { utc } = parseInicia("2025-03-15T14:00:00Z");
    expect(utc).toBe("2025-03-15T14:00:00.000Z");
  });
  it("devuelve objeto Date válido", () => {
    const { localDt } = parseInicia("2025-03-15T10:00:00-04:00");
    expect(localDt instanceof Date).toBe(true);
    expect(isNaN(localDt.getTime())).toBe(false);
  });
});
