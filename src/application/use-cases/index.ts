// src/application/use-cases/index.ts

export { agendarCita } from "./agendar-cita.js";
export type { AgendarCitaInput, AgendarCitaResult } from "./agendar-cita.js";

export { cancelarCita } from "./cancelar-cita.js";
export type { CancelarCitaInput } from "./cancelar-cita.js";

export { reagendarCita } from "./reagendar-cita.js";
export type { ReagendarCitaInput, ReagendarCitaResult } from "./reagendar-cita.js";

export { listarHorariosLibres } from "./listar-horarios.js";
export type { ListarHorariosInput, SlotDisponible } from "./listar-horarios.js";

export { consultarCitaPorCodigo, consultarCitasActivasPorTelefono } from "./consultar-cita.js";
export type { CitaDetalle } from "./consultar-cita.js";
