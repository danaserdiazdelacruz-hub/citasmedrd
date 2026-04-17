// src/bot/toolDefs.ts — 9 herramientas para Claude Tool Calling
// Incluye tools informativas, de agendamiento y de gestión

export const TOOL_DEFINITIONS = [
  {
    name: "buscar_doctor",
    description: "Busca un doctor por nombre, apellido o extensión. Úsala siempre que el paciente mencione a un doctor. Busca también por palabras parciales (ej: 'hairol', 'perez', '1006').",
    input_schema: {
      type: "object" as const,
      properties: {
        texto: { type: "string", description: "Nombre, apellido o extensión del doctor" },
      },
      required: ["texto"],
      additionalProperties: false,
    },
  },
  {
    name: "buscar_sedes",
    description: "Obtiene TODAS las sedes/clínicas donde atiende un doctor. Devuelve nombre, ciudad, dirección y teléfono de cada sede. Úsala para informar o para que el paciente elija sede.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctor_id: { type: "string", description: "UUID del doctor" },
      },
      required: ["doctor_id"],
      additionalProperties: false,
    },
  },
  {
    name: "buscar_servicios",
    description: "Obtiene los tipos de consulta disponibles en una sede (primera vez, seguimiento, etc.). Úsala para saber qué servicios ofrece el doctor en esa sede.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctor_clinica_id: { type: "string", description: "UUID de la relación doctor-clínica (viene de buscar_sedes)" },
      },
      required: ["doctor_clinica_id"],
      additionalProperties: false,
    },
  },
  {
    name: "consultar_info",
    description: "Consulta información general sobre un doctor en una sede SIN necesidad de agendar. Úsala cuando el paciente SOLO quiere saber horarios, disponibilidad o información general. NO requiere nombre, teléfono ni motivo del paciente. Devuelve días disponibles y horarios.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctor_clinica_id: { type: "string", description: "UUID de la relación doctor-clínica" },
        fecha: { type: "string", description: "Fecha específica YYYY-MM-DD (opcional, si el paciente pregunta por un día)" },
        dia_semana: { type: "string", description: "Día de la semana (opcional, ej: 'jueves', 'lunes'). Si se da, busca el próximo día que coincida" },
      },
      required: ["doctor_clinica_id"],
      additionalProperties: false,
    },
  },
  {
    name: "buscar_disponibilidad",
    description: "Busca días con horarios disponibles para los próximos 14 días. Úsala cuando el paciente YA quiere agendar y tienes doctor + sede. El servicio_id se auto-detecta si no lo tienes.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctor_clinica_id: { type: "string", description: "UUID de la relación doctor-clínica" },
        servicio_id: { type: "string", description: "UUID del servicio (opcional, se auto-detecta)" },
      },
      required: ["doctor_clinica_id"],
      additionalProperties: false,
    },
  },
  {
    name: "buscar_horarios",
    description: "Obtiene horarios específicos disponibles para un día concreto. Úsala cuando el paciente elige un día o quiere ver las horas de un día específico.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctor_clinica_id: { type: "string", description: "UUID de la relación doctor-clínica" },
        servicio_id: { type: "string", description: "UUID del servicio (opcional, se auto-detecta)" },
        fecha: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
      },
      required: ["doctor_clinica_id", "fecha"],
      additionalProperties: false,
    },
  },
  {
    name: "agendar_cita",
    description: "Agenda una cita médica. SOLO úsala cuando tengas TODOS los datos confirmados: doctor_clinica_id, horario (inicia_en), nombre completo, teléfono (10 dígitos) y motivo. NUNCA la uses sin tener todos los datos.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctor_clinica_id: { type: "string", description: "UUID de la relación doctor-clínica" },
        servicio_id: { type: "string", description: "UUID del servicio (opcional, se auto-detecta)" },
        inicia_en: { type: "string", description: "Timestamp ISO exacto del slot seleccionado" },
        nombre: { type: "string", description: "Nombre completo del paciente" },
        telefono: { type: "string", description: "Teléfono (10 dígitos: 809/829/849 + 7 dígitos)" },
        motivo: { type: "string", description: "Motivo de la consulta" },
      },
      required: ["doctor_clinica_id", "inicia_en", "nombre", "telefono", "motivo"],
      additionalProperties: false,
    },
  },
  {
    name: "cancelar_cita",
    description: "Cancela una cita por su código. El código tiene formato CITA-XXXXXX (6 caracteres alfanuméricos).",
    input_schema: {
      type: "object" as const,
      properties: {
        codigo: { type: "string", description: "Código de la cita (ej: CITA-ABC123)" },
      },
      required: ["codigo"],
      additionalProperties: false,
    },
  },
  {
    name: "consultar_cita",
    description: "Busca información de una cita existente por su código. Úsala cuando el paciente quiera saber el estado de su cita o necesite detalles.",
    input_schema: {
      type: "object" as const,
      properties: {
        codigo: { type: "string", description: "Código de la cita (ej: CITA-ABC123)" },
      },
      required: ["codigo"],
      additionalProperties: false,
    },
  },
];
