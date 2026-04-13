export type BotPaso =
  | "inicio"
  | "elegir_dia"
  | "elegir_hora"
  | "cancelar_cita";

export interface DoctorResumen {
  id: string;
  nombre: string;
  apellido: string;
  extension?: string;
  especialidades?: { especialidades: { nombre: string } }[];
}

export interface SedeResumen {
  id: string;
  clinicas: {
    nombre: string;
    ciudad: string;
    direccion?: string;
    telefono?: string;
  };
}

export interface ServicioResumen {
  id: string;
  nombre: string;
  duracion_min: number;
  tipo: string;
}

export interface SlotResumen {
  num: number;
  hora: string;
  inicia_en: string;
}

export interface BotSesion {
  paso?: BotPaso;
  historial?: { role: string; content: string }[];

  // Doctor
  doctor_id?: string;
  doctor_nombre?: string;
  doctor_extension?: string;
  doctores_multiples?: DoctorResumen[];

  // Sede
  sede_id?: string;
  sede_nombre?: string;
  sedes_disponibles?: SedeResumen[];

  // Servicios
  servicio_id?: string;
  servicios_disponibles?: ServicioResumen[];

  // Paciente
  nombre?: string;
  telefono?: string;
  motivo?: string;
  es_primera?: boolean;

  // Disponibilidad
  dias_disponibles?: { fecha: string; total_slots: number }[];
  slots_disponibles?: string;
  fecha_sel?: string;
  slots?: SlotResumen[];
  slot_sel?: SlotResumen;
}
