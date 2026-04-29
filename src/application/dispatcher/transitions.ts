// src/application/dispatcher/transitions.ts
// Matriz de transiciones válidas del FSM.
// Función pura: (EstadoActual, EstadoDestino) → boolean.
// Sin side-effects, sin imports de infraestructura.

import type { EstadoSesion } from "../../persistence/repositories/index.js";

export const TRANSICIONES_VALIDAS: Record<EstadoSesion, EstadoSesion[]> = {
  IDLE:                  ["ELIGIENDO_SEDE", "PIDIENDO_TELEFONO"],
  ELIGIENDO_INTENCION:   ["ELIGIENDO_SEDE", "PIDIENDO_TELEFONO", "IDLE"],
  ELIGIENDO_PROFESIONAL: ["ELIGIENDO_SEDE", "IDLE"],
  ELIGIENDO_SEDE:        ["ELIGIENDO_SERVICIO", "IDLE"],
  ELIGIENDO_SERVICIO:    ["ELIGIENDO_HORA", "IDLE"],
  ELIGIENDO_HORA:        ["PIDIENDO_NOMBRE", "ELIGIENDO_HORA", "IDLE"],
  PIDIENDO_NOMBRE:       ["PIDIENDO_TELEFONO", "PIDIENDO_NOMBRE", "IDLE"],
  PIDIENDO_TELEFONO:     ["ELIGIENDO_TIPO_PAGO", "CONSULTANDO_CITA", "CANCELANDO_CITA", "PIDIENDO_TELEFONO", "IDLE"],
  ELIGIENDO_TIPO_PAGO:   ["CONFIRMANDO", "IDLE"],
  ELIGIENDO_ASEGURADORA: ["CONFIRMANDO", "IDLE"],
  CONFIRMANDO:           ["IDLE"],
  CONSULTANDO_CITA:      ["IDLE"],
  CANCELANDO_CITA:       ["IDLE"],
  REAGENDANDO_CITA:      ["IDLE"],
};

export function transicionValida(desde: EstadoSesion, hacia: EstadoSesion): boolean {
  if (desde === hacia) return true;
  return TRANSICIONES_VALIDAS[desde]?.includes(hacia) ?? false;
}
