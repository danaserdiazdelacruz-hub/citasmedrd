// src/bot/toolDefs.ts — Definiciones de herramientas para Claude
// Cada herramienta tiene: name, description, input_schema (JSON Schema)

export const TOOL_DEFINITIONS = [
  {
    name: "buscar_doctor",
    description: "Busca un doctor por nombre, apellido o número de extensión en la base de datos. Úsala cuando el paciente mencione el nombre de un doctor.",
    input_schema: {
      type: "object" as const,
      properties: {
        texto: { type: "string", description: "Nombre, apellido o extensión del doctor" },
      },
      required: ["texto"],
    },
  },
  {
    name: "buscar_sedes",
    description: "Obtiene las sedes/clínicas donde atiende un doctor específico. Úsala después de identificar al doctor.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctor_id: { type: "string", description: "UUID del doctor" },
      },
      required: ["doctor_id"],
    },
  },
  {
    name: "buscar_servicios",
    description: "Obtiene los tipos de consulta disponibles en una sede. Úsala después de que el paciente elija sede.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctor_clinica_id: { type: "string", description: "UUID de la relación doctor-clínica" },
      },
      required: ["doctor_clinica_id"],
    },
  },
  {
    name: "buscar_disponibilidad",
    description: "Busca los días con horarios disponibles para los próximos 14 días. Úsala cuando tengas doctor + sede + servicio.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctor_clinica_id: { type: "string", description: "UUID de la relación doctor-clínica" },
        servicio_id: { type: "string", description: "UUID del servicio/tipo de consulta" },
      },
      required: ["doctor_clinica_id", "servicio_id"],
    },
  },
  {
    name: "buscar_horarios",
    description: "Obtiene los horarios específicos disponibles para un día. Úsala cuando el paciente elija un día.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctor_clinica_id: { type: "string", description: "UUID de la relación doctor-clínica" },
        servicio_id: { type: "string", description: "UUID del servicio" },
        fecha: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
      },
      required: ["doctor_clinica_id", "servicio_id", "fecha"],
    },
  },
  {
    name: "agendar_cita",
    description: "Agenda una cita médica. SOLO úsala cuando tengas TODOS los datos: doctor, sede, servicio, horario, nombre, teléfono y motivo del paciente.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctor_clinica_id: { type: "string", description: "UUID de la relación doctor-clínica" },
        servicio_id: { type: "string", description: "UUID del servicio" },
        inicia_en: { type: "string", description: "Timestamp ISO del horario seleccionado" },
        nombre: { type: "string", description: "Nombre completo del paciente" },
        telefono: { type: "string", description: "Teléfono del paciente (10 dígitos)" },
        motivo: { type: "string", description: "Motivo de la consulta" },
      },
      required: ["doctor_clinica_id", "servicio_id", "inicia_en", "nombre", "telefono", "motivo"],
    },
  },
  {
    name: "cancelar_cita",
    description: "Cancela una cita existente por su código. El código tiene formato CITA-XXXXXX.",
    input_schema: {
      type: "object" as const,
      properties: {
        codigo: { type: "string", description: "Código de la cita (ej: CITA-ABC123)" },
      },
      required: ["codigo"],
    },
  },
];
