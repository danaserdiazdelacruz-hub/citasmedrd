// tests/unit/comandos.test.ts
// Tests del intérprete de comandos escritos como texto.

import { describe, it, expect } from "vitest";
import { textoComoComando } from "../../src/domain/comandos.js";

describe("textoComoComando", () => {
  it("reconoce /start exacto", () => {
    expect(textoComoComando("/start")).toBe("start");
  });

  it("normaliza mayúsculas y mixto", () => {
    expect(textoComoComando("/Start")).toBe("start");
    expect(textoComoComando("/START")).toBe("start");
    expect(textoComoComando("/StArT")).toBe("start");
  });

  it("tolera el typo /Star (sin t final)", () => {
    expect(textoComoComando("/Star")).toBe("start");
  });

  it("tolera variaciones tipo /starts, /starting", () => {
    expect(textoComoComando("/starts")).toBe("start");
    expect(textoComoComando("/starting")).toBe("start");
  });

  it("acepta sinónimos /inicio y /comenzar", () => {
    expect(textoComoComando("/inicio")).toBe("start");
    expect(textoComoComando("/comenzar")).toBe("start");
  });

  it("reconoce /menu, /Menú, /menus", () => {
    expect(textoComoComando("/menu")).toBe("menu");
    expect(textoComoComando("/Menu")).toBe("menu");
    expect(textoComoComando("/menú")).toBe("menu");
    expect(textoComoComando("/menus")).toBe("menu");
  });

  it("reconoce /cancelar y variantes", () => {
    expect(textoComoComando("/cancelar")).toBe("cancelar");
    expect(textoComoComando("/Cancelar")).toBe("cancelar");
    expect(textoComoComando("/cancela")).toBe("cancelar");
    expect(textoComoComando("/salir")).toBe("cancelar");
  });

  it("ignora @bot suffix", () => {
    expect(textoComoComando("/start@CitasmedBot")).toBe("start");
    expect(textoComoComando("/menu@MyBot")).toBe("menu");
  });

  it("devuelve null si no empieza con /", () => {
    expect(textoComoComando("start")).toBeNull();
    expect(textoComoComando("hola")).toBeNull();
    expect(textoComoComando("")).toBeNull();
  });

  it("devuelve null para comandos desconocidos", () => {
    expect(textoComoComando("/foobar")).toBeNull();
    expect(textoComoComando("/agendar")).toBeNull();  // no es un comando registrado
    expect(textoComoComando("/123")).toBeNull();
  });

  it("devuelve null para texto largo (no es comando)", () => {
    expect(textoComoComando("/start podrías ayudarme con esto?")).toBeNull();
    expect(textoComoComando("/" + "a".repeat(50))).toBeNull();
  });

  it("devuelve null para slash sin contenido", () => {
    expect(textoComoComando("/")).toBeNull();
    expect(textoComoComando("/   ")).toBeNull();
  });

  it("maneja whitespace alrededor", () => {
    expect(textoComoComando("  /start  ")).toBe("start");
    expect(textoComoComando("\n/Menu\n")).toBe("menu");
  });

  it("retorna null para input no string", () => {
    expect(textoComoComando(null as unknown as string)).toBeNull();
    expect(textoComoComando(undefined as unknown as string)).toBeNull();
    expect(textoComoComando(123 as unknown as string)).toBeNull();
  });
});
