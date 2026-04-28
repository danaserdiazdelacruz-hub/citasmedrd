// tests/unit/historial-llm.test.ts
// Tests del sanitizador de historial para el LLM.

import { describe, it, expect } from "vitest";
import { extraerHistorialParaLLM } from "../../src/domain/historial.js";

describe("extraerHistorialParaLLM", () => {
  it("devuelve [] cuando el historial no es array", () => {
    expect(extraerHistorialParaLLM(null, "hola")).toEqual([]);
    expect(extraerHistorialParaLLM(undefined, "hola")).toEqual([]);
    expect(extraerHistorialParaLLM("no es array" as unknown, "hola")).toEqual([]);
    expect(extraerHistorialParaLLM({} as unknown, "hola")).toEqual([]);
  });

  it("devuelve [] cuando el historial está vacío", () => {
    expect(extraerHistorialParaLLM([], "hola")).toEqual([]);
  });

  it("filtra turnos sin role válido", () => {
    const h = [
      { role: "user", content: "hola" },
      { role: "system", content: "esto debe filtrarse" },
      { role: "robot", content: "esto también" },
      { role: "assistant", content: "respuesta" },
    ];
    const r = extraerHistorialParaLLM(h, "ZZZ");
    expect(r).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "respuesta" },
    ]);
  });

  it("filtra turnos con content vacío o no-string", () => {
    const h = [
      { role: "user", content: "" },
      { role: "user", content: "   " },
      { role: "user", content: null },
      { role: "user", content: 123 },
      { role: "user", content: "válido" },
    ];
    const r = extraerHistorialParaLLM(h, "ZZZ");
    expect(r).toEqual([{ role: "user", content: "válido" }]);
  });

  it("elimina el último turno del usuario si coincide con el mensaje actual", () => {
    const h = [
      { role: "user", content: "primero" },
      { role: "assistant", content: "respondí" },
      { role: "user", content: "duplicado" },
    ];
    const r = extraerHistorialParaLLM(h, "duplicado");
    expect(r).toEqual([
      { role: "user", content: "primero" },
      { role: "assistant", content: "respondí" },
    ]);
  });

  it("NO elimina el último turno si no coincide con el mensaje actual", () => {
    const h = [
      { role: "user", content: "primero" },
      { role: "user", content: "diferente" },
    ];
    const r = extraerHistorialParaLLM(h, "mensaje actual distinto");
    expect(r).toEqual([
      { role: "user", content: "primero" },
      { role: "user", content: "diferente" },
    ]);
  });

  it("descarta assistant inicial (Anthropic exige que la conversación arranque con user)", () => {
    const h = [
      { role: "assistant", content: "no debería estar al inicio" },
      { role: "user", content: "hola" },
      { role: "assistant", content: "qué tal" },
    ];
    const r = extraerHistorialParaLLM(h, "ZZZ");
    expect(r).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "qué tal" },
    ]);
  });

  it("descarta multiples assistant iniciales en cadena", () => {
    const h = [
      { role: "assistant", content: "uno" },
      { role: "assistant", content: "dos" },
      { role: "user", content: "primer user real" },
    ];
    const r = extraerHistorialParaLLM(h, "ZZZ");
    expect(r).toEqual([{ role: "user", content: "primer user real" }]);
  });

  it("limita a los últimos 10 turnos", () => {
    const h: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 25; i++) {
      h.push({ role: i % 2 === 0 ? "user" : "assistant", content: `t${i}` });
    }
    const r = extraerHistorialParaLLM(h, "ZZZ");
    expect(r.length).toBe(10);
    expect(r[r.length - 1].content).toBe("t24");
  });

  it("ignora turnos malformados (no objeto)", () => {
    const h = [
      "string suelto",
      null,
      undefined,
      42,
      { role: "user", content: "válido" },
    ];
    const r = extraerHistorialParaLLM(h, "ZZZ");
    expect(r).toEqual([{ role: "user", content: "válido" }]);
  });

  it("acepta historial real de la DB con campo ts extra", () => {
    const h = [
      { role: "user", content: "quiero cita", ts: "2026-04-28T10:00:00Z" },
      { role: "assistant", content: "claro, te ayudo", ts: "2026-04-28T10:00:01Z" },
      { role: "user", content: "con hairol perez", ts: "2026-04-28T10:00:30Z" },
    ];
    const r = extraerHistorialParaLLM(h, "con hairol perez");
    expect(r).toEqual([
      { role: "user", content: "quiero cita" },
      { role: "assistant", content: "claro, te ayudo" },
    ]);
  });
});
