// ================================================================
// config.ts — Doctores y sedes configurados.
// Por ahora hardcodeado para el Dr. Hairol.
// En el futuro: cargar desde Supabase con caché.
// ================================================================
import { DoctorConfig } from "./types.js";

export const DOCTORES: DoctorConfig[] = [
  {
    nombre: "Dr. Hairol Pérez",
    especialidad: "Oncología / Ginecología",
    sedes: [
      {
        dc_id:    "de3198c7-f29c-43ef-9d45-d86b1d3ece2b",
        nombre:   "Centro Médico María Dolores",
        ciudad:   "Santo Domingo",
        servicios: {
          primera_vez: "925debe7-122c-487e-831c-7e859706847a",
          seguimiento: "ae5c6295-ef89-490b-b24b-4ae1963aabe3",
        },
      },
      {
        dc_id:    "6223eb63-2ff7-4681-92b8-74a03a593f6b",
        nombre:   "Unidad Oncológica del Este",
        ciudad:   "San Pedro de Macorís",
        servicios: {
          primera_vez: "389c94c6-74cf-490e-9b32-42975283ede9",
          seguimiento: "0b3f03f4-6a96-41f8-b7e3-7342a5f9deba",
        },
      },
      {
        dc_id:    "cbae370e-3895-4d78-be06-fdd06924bcbc",
        nombre:   "Centro Médico Doctor Paulino",
        ciudad:   "Jimaní",
        servicios: {
          primera_vez: "9b29fe96-5328-433d-b374-91fcb475c6cc",
          seguimiento: "54699935-adc0-4d88-8718-be657fab50a2",
        },
      },
    ],
  },
];
