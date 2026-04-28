// src/persistence/repositories/index.ts
// Barrel export para imports limpios:
//   import { citasRepo, pacientesRepo } from "@/persistence/repositories";

export { citasRepo } from "./citas.repo.js";
export { pacientesRepo } from "./pacientes.repo.js";
export { profesionalesRepo } from "./profesionales.repo.js";
export { sesionesRepo } from "./sesiones.repo.js";
export { tenantsRepo } from "./tenants.repo.js";

export type { AgendarInput, CancelarInput, ReagendarInput, ListarHorariosInput } from "./citas.repo.js";
export type { Paciente, GetOrCreateInput } from "./pacientes.repo.js";
export type { Profesional, Sede, ProfesionalSede, Servicio, HorarioAtencion } from "./profesionales.repo.js";
export type { SesionConversacion, EstadoSesion, UpsertSesionInput } from "./sesiones.repo.js";
export type { Tenant, CanalConectado, TipoCanal } from "./tenants.repo.js";
export type { RpcResult, AgendarResult, CancelarResult, ReagendarResult, HorarioLibre, CanalOrigen, TipoPago, PacienteResult } from "./types.js";
