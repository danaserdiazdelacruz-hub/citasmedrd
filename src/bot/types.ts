export type BotPaso =
  | "inicio"
  | "elegir_dia"
  | "elegir_hora"
  | "cancelar_cita";

export interface BotSesion {
  paso?: BotPaso;
  historial?: { role: string; content: string }[];
  nombre?: string;
  telefono?: string;
  motivo?: string;
  sede_id?: string;
  sede_nombre?: string;
  servicio_id?: string;
  es_primera?: boolean;
  dias_disponibles?: { fecha: string; total_slots: number }[];
  slots_disponibles?: string;
  fecha_sel?: string;
  slots?: { num: number; hora: string; inicia_en: string }[];
  slot_sel?: { num: number; hora: string; inicia_en: string };
}

export interface DoctorConfig {
  nombre: string;
  especialidad: string;
  sedes: SedeConfig[];
}

export interface SedeConfig {
  dc_id: string;
  nombre: string;
  ciudad: string;
  servicios: {
    primera_vez: string;
    seguimiento: string;
  };
}
