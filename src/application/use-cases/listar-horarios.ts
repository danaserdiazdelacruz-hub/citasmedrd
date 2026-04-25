// src/application/use-cases/listar-horarios.ts
// Lista horarios libres en un día para un profesional_sede.
// Devuelve un array de slots con timestamp y cupos disponibles.
// El backend decide cómo presentar (botones, lista, etc.) según canal.

import { citasRepo } from "../../persistence/repositories/index.js";
import type { HorarioLibre } from "../../persistence/repositories/index.js";

export interface ListarHorariosInput {
  profesionalSedeId: string;
  fecha: string;          // YYYY-MM-DD en timezone del tenant
}

export interface SlotDisponible {
  iniciaEn: string;       // ISO con offset
  cuposLibres: number;
  horaDisplay: string;    // "08:00 AM" — para mostrar al usuario
}

export async function listarHorariosLibres(input: ListarHorariosInput): Promise<SlotDisponible[]> {
  const slots: HorarioLibre[] = await citasRepo.listarHorariosLibres({
    profesionalSedeId: input.profesionalSedeId,
    fecha: input.fecha,
  });

  return slots.map(slot => ({
    iniciaEn: slot.inicia_en,
    cuposLibres: slot.cupos_libres,
    horaDisplay: formatHora(slot.inicia_en),
  }));
}

function formatHora(iso: string): string {
  const date = new Date(iso);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 || 12;
  const mm = String(minutes).padStart(2, "0");
  return `${h12}:${mm} ${ampm}`;
}
