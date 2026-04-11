// ================================================================
// types.ts — Tipos de la sesión del bot
// La sesión vive en Supabase (bot_sesiones) para que sea
// persistente y funcione aunque el servidor se reinicie.
// ================================================================

export type BotPaso =
  | "inicio"
  | "elegir_doctor"
  | "elegir_sede"
  | "tipo_consulta"
  | "nombre"
  | "telefono"
  | "motivo"
  | "buscando_slots"
  | "elegir_dia"
  | "elegir_hora"
  | "confirmar"
  | "cancelar_cita";

export interface BotSesion {
  paso: BotPaso;
  // Doctor seleccionado
  doctor_nombre?: string;
  // Sede seleccionada
  sede_id?: string;         // doctor_clinica_id
  sede_nombre?: string;
  // Servicio
  servicio_id?: string;
  es_primera?: boolean;
  // Paciente
  nombre?: string;
  telefono?: string;
  motivo?: string;
  // Disponibilidad
  dias_disponibles?: { fecha: string; total_slots: number }[];
  fecha_sel?: string;
  slots?: { inicia_en: string; hora: string }[];
  slot_sel?: { inicia_en: string; hora: string };
}

// Doctores configurados en el sistema
// En el futuro esto vendría de Supabase dinámicamente
export interface DoctorConfig {
  nombre: string;
  especialidad: string;
  sedes: SedeConfig[];
}

export interface SedeConfig {
  dc_id: string;   // doctor_clinica_id en Supabase
  nombre: string;
  ciudad: string;
  servicios: {
    primera_vez: string;   // servicio_id
    seguimiento: string;
  };
}
