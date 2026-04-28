// tests/unit/horarios.test.ts
// Tests del resumidor de horarios de atención.

import { describe, it, expect } from "vitest";
import { resumirHorariosAtencion, type HorarioAtencionRaw } from "../../src/domain/horarios.js";

const h = (
  dia_semana: number,
  hora_inicio: string,
  hora_fin: string,
  pausa?: { inicio: string; fin: string },
): HorarioAtencionRaw => ({
  dia_semana,
  hora_inicio,
  hora_fin,
  tiene_pausa: !!pausa,
  pausa_inicio: pausa?.inicio ?? null,
  pausa_fin: pausa?.fin ?? null,
});

describe("resumirHorariosAtencion", () => {
  it("devuelve [] cuando no hay horarios", () => {
    expect(resumirHorariosAtencion([])).toEqual([]);
  });

  it("agrupa días con la misma franja simple", () => {
    const horarios = [
      h(1, "08:00:00", "12:00:00"),
      h(2, "08:00:00", "12:00:00"),
      h(5, "08:00:00", "12:00:00"),
    ];
    const r = resumirHorariosAtencion(horarios);
    expect(r).toEqual(["Lun, Mar, Vie: 08:00-12:00"]);
  });

  it("maneja horarios con pausa (mañana + tarde)", () => {
    const horarios = [
      h(1, "08:00:00", "17:00:00", { inicio: "12:00:00", fin: "14:00:00" }),
      h(2, "08:00:00", "17:00:00", { inicio: "12:00:00", fin: "14:00:00" }),
    ];
    const r = resumirHorariosAtencion(horarios);
    expect(r).toEqual(["Lun, Mar: 08:00-12:00, 14:00-17:00"]);
  });

  it("separa grupos cuando los días tienen franjas distintas", () => {
    const horarios = [
      h(1, "08:00:00", "12:00:00"),
      h(2, "14:00:00", "18:00:00"),
      h(3, "08:00:00", "12:00:00"),
    ];
    const r = resumirHorariosAtencion(horarios);
    expect(r.sort()).toEqual([
      "Lun, Mié: 08:00-12:00",
      "Mar: 14:00-18:00",
    ].sort());
  });

  it("ordena los días dentro de cada grupo en orden Dom-Sáb", () => {
    const horarios = [
      h(5, "09:00:00", "13:00:00"),  // Vie
      h(1, "09:00:00", "13:00:00"),  // Lun
      h(3, "09:00:00", "13:00:00"),  // Mié
    ];
    const r = resumirHorariosAtencion(horarios);
    expect(r).toEqual(["Lun, Mié, Vie: 09:00-13:00"]);
  });

  it("recorta los segundos de las horas tipo HH:MM:SS", () => {
    const horarios = [h(1, "08:30:45", "12:15:30")];
    const r = resumirHorariosAtencion(horarios);
    expect(r).toEqual(["Lun: 08:30-12:15"]);
  });

  it("ignora pausas si tiene_pausa=false aunque pausa_inicio/fin tengan valor", () => {
    const horarios: HorarioAtencionRaw[] = [{
      dia_semana: 1,
      hora_inicio: "08:00:00",
      hora_fin: "17:00:00",
      tiene_pausa: false,
      pausa_inicio: "12:00:00",
      pausa_fin: "14:00:00",
    }];
    const r = resumirHorariosAtencion(horarios);
    expect(r).toEqual(["Lun: 08:00-17:00"]);
  });

  it("incluye sábado y domingo si están registrados", () => {
    const horarios = [
      h(0, "09:00:00", "13:00:00"),  // Dom
      h(6, "09:00:00", "13:00:00"),  // Sáb
    ];
    const r = resumirHorariosAtencion(horarios);
    expect(r).toEqual(["Dom, Sáb: 09:00-13:00"]);
  });

  it("dedupe días si llegan dos filas para el mismo día con misma franja", () => {
    const horarios = [
      h(1, "08:00:00", "12:00:00"),
      h(1, "08:00:00", "12:00:00"),
    ];
    const r = resumirHorariosAtencion(horarios);
    expect(r).toEqual(["Lun: 08:00-12:00"]);
  });
});
