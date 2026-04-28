// src/application/llm/prompt-builder.ts
// Construye el system prompt con datos REALES del tenant desde la DB.
//
// Filosofía: el bot CONVERSA. No es un IVR de botones. Cuando el usuario
// hace small talk, pregunta cosas, o duda, respondemos en texto natural.
// Solo invocamos detectar_intencion cuando hay una intención CLARA de
// agendar/consultar/cancelar.
//
// CAMBIO: ahora el prompt incluye toda la información operativa del consultorio
// que ya está en la DB (direcciones, teléfonos, horarios, precios) más una sección
// de FAQ configurable por tenant para preguntas frecuentes que no están en el schema
// (atiende niños, parqueo, virtuales, etc).

export interface ProfesionalResumen {
  display: string;
  /** Especialidad si se conoce (de tipos_profesional o configuración). */
  especialidad?: string;
  /** Bio corta del profesional (de la columna `bio_corta`). */
  bio?: string | null;
  /** Años de experiencia si está registrado. */
  anosExperiencia?: number | null;
}

export interface SedeResumen {
  nombre: string;
  ciudad?: string | null;
  /** Dirección completa (calle/número/sector). */
  direccion?: string | null;
  /** Teléfono de la sede. */
  telefono?: string | null;
  /** Si la sede tiene coordenadas, podemos ofrecer enviar ubicación. */
  tieneUbicacion?: boolean;
}

export interface ServicioResumen {
  nombre: string;
  /** Descripción pública (de `descripcion_publica`). */
  descripcion?: string | null;
  precio?: number;
  duracionMin?: number;
  moneda?: string;
}

export interface HorarioResumen {
  /** "L-V 8:00-12:00, 14:00-17:00" formato resumido. */
  texto: string;
}

export interface CitaActivaResumen {
  servicio: string;
  fechaHora: string;
  codigo: string;
}

/**
 * FAQ configurable por tenant. Vive en `tenants.configuracion.faq`.
 * Todos los campos son opcionales — si el consultorio no configura uno,
 * el bot responde "te recomiendo llamar al consultorio para esa pregunta".
 */
export interface FAQTenant {
  atiende_emergencias?: boolean;
  consultas_virtuales?: boolean;
  atiende_ninos?: boolean;
  tiene_parqueo?: boolean;
  tiempo_espera_promedio_min?: number;
  /** Texto libre con instrucciones antes de la consulta. */
  indicaciones_previas?: string;
  /** Si true, el bot puede ofrecer enviar la ubicación por el chat. */
  puede_enviar_ubicacion?: boolean;
  /** Lista de métodos aceptados, ej: ["efectivo", "tarjeta", "transferencia"]. */
  metodos_pago?: string[];
  aceptan_seguros?: boolean;
  /** Lista de aseguradoras aceptadas si el tenant las tiene configuradas. */
  aseguradoras?: string[];
  /** Edad mínima atendida (ej: 12 si solo adolescentes/adultos). */
  edad_minima?: number;
  /** Edad máxima atendida (ej: 18 para pediatría). */
  edad_maxima?: number;
  /** Texto libre — cualquier nota adicional que el consultorio quiera. */
  notas_adicionales?: string;
}

export interface PromptContext {
  nombreClinica: string;
  tipoEntidad: "individual" | "clinica";
  profesionales: ProfesionalResumen[];
  sedes: SedeResumen[];
  servicios: ServicioResumen[];
  estadoSesion: string;
  /** Horario(s) de atención del primer profesional/sede como referencia general. */
  horarios?: HorarioResumen[];
  /** Si el paciente es conocido (memoria a largo plazo) */
  pacienteNombre?: string;
  /** Si tiene una cita activa, la mencionamos para que el LLM pueda referirla */
  citaActiva?: CitaActivaResumen;
  /** Nombre de la asistente virtual (default "María Salud", configurable por tenant). */
  nombreAsistente?: string;
  /** FAQ configurable por tenant para preguntas frecuentes. */
  faq?: FAQTenant;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const tipoTexto = ctx.tipoEntidad === "clinica" ? "clínica" : "consultorio";
  const nombreAsistente = ctx.nombreAsistente ?? "María Salud";

  // ─── Profesionales ─────────────────────────────────────────────────
  const profsText = ctx.profesionales.length === 0
    ? "(sin profesionales configurados)"
    : ctx.profesionales.map(p => {
        const partes: string[] = [`- ${p.display}`];
        if (p.especialidad) partes.push(`(${p.especialidad})`);
        if (p.anosExperiencia && p.anosExperiencia > 0) {
          partes.push(`— ${p.anosExperiencia} años de experiencia`);
        }
        let linea = partes.join(" ");
        if (p.bio) linea += `\n   ${p.bio}`;
        return linea;
      }).join("\n");

  // ─── Sedes con detalles ────────────────────────────────────────────
  const sedesText = ctx.sedes.length === 0
    ? "(sin sedes configuradas)"
    : ctx.sedes.map(s => {
        const partes: string[] = [`- *${s.nombre}*`];
        if (s.ciudad) partes.push(`(${s.ciudad})`);
        let linea = partes.join(" ");
        if (s.direccion) linea += `\n   📍 ${s.direccion}`;
        if (s.telefono) linea += `\n   ☎️ ${s.telefono}`;
        if (s.tieneUbicacion) linea += `\n   📌 Puedes ofrecer enviar la ubicación si te la piden`;
        return linea;
      }).join("\n");

  // ─── Servicios con precios y duración ──────────────────────────────
  const serviciosText = ctx.servicios.length === 0
    ? "(consulta el catálogo al usuario)"
    : ctx.servicios.slice(0, 12).map(s => {
        const partes: string[] = [`- *${s.nombre}*`];
        if (s.precio !== undefined && s.precio > 0) {
          const moneda = s.moneda || "DOP";
          partes.push(`— ${moneda} ${s.precio.toLocaleString()}`);
        }
        if (s.duracionMin) partes.push(`(${s.duracionMin} min)`);
        let linea = partes.join(" ");
        if (s.descripcion) linea += `\n   ${s.descripcion}`;
        return linea;
      }).join("\n");

  // ─── Horarios de atención ──────────────────────────────────────────
  const horariosText = (ctx.horarios && ctx.horarios.length > 0)
    ? ctx.horarios.map(h => `- ${h.texto}`).join("\n")
    : "(no configurados — sugiere llamar al consultorio para confirmar)";

  // ─── FAQ block ─────────────────────────────────────────────────────
  const faq = ctx.faq ?? {};
  const faqLines: string[] = [];
  if (faq.atiende_emergencias !== undefined) {
    faqLines.push(`- Emergencias: ${faq.atiende_emergencias ? "SÍ atienden" : "NO atienden, recomiendan ir a un centro de emergencias"}`);
  }
  if (faq.consultas_virtuales !== undefined) {
    faqLines.push(`- Consultas virtuales: ${faq.consultas_virtuales ? "SÍ disponibles" : "NO, solo presenciales"}`);
  }
  if (faq.atiende_ninos !== undefined) {
    const edadInfo = faq.edad_minima || faq.edad_maxima
      ? ` (edad ${faq.edad_minima ?? 0} – ${faq.edad_maxima ?? "sin tope"})`
      : "";
    faqLines.push(`- Atiende niños: ${faq.atiende_ninos ? "SÍ" : "NO"}${edadInfo}`);
  }
  if (faq.tiene_parqueo !== undefined) {
    faqLines.push(`- Parqueo: ${faq.tiene_parqueo ? "SÍ disponible" : "NO disponible"}`);
  }
  if (faq.tiempo_espera_promedio_min !== undefined) {
    faqLines.push(`- Tiempo de espera promedio: ${faq.tiempo_espera_promedio_min} minutos`);
  }
  if (faq.indicaciones_previas) {
    faqLines.push(`- Indicaciones antes de la consulta: ${faq.indicaciones_previas}`);
  }
  if (faq.puede_enviar_ubicacion !== undefined && faq.puede_enviar_ubicacion) {
    faqLines.push(`- Puedes ofrecer enviar la ubicación por el chat si la piden`);
  }
  if (faq.metodos_pago && faq.metodos_pago.length > 0) {
    faqLines.push(`- Métodos de pago aceptados: ${faq.metodos_pago.join(", ")}`);
  }
  if (faq.aceptan_seguros !== undefined) {
    const segs = faq.aseguradoras && faq.aseguradoras.length > 0
      ? ` (${faq.aseguradoras.join(", ")})`
      : "";
    faqLines.push(`- Seguros médicos: ${faq.aceptan_seguros ? `SÍ aceptan${segs}` : "NO aceptan"}`);
  }
  if (faq.notas_adicionales) {
    faqLines.push(`- Otras notas: ${faq.notas_adicionales}`);
  }
  const faqText = faqLines.length > 0
    ? faqLines.join("\n")
    : "(no configurado — para preguntas que no estén arriba, sugiere llamar al consultorio directamente)";

  // ─── Memoria del paciente / cita activa ────────────────────────────
  const memoriaPaciente = ctx.pacienteNombre
    ? `\nEL PACIENTE YA TE CONOCE: se llama ${ctx.pacienteNombre}. Salúdalo por su nombre cuando sea natural, sin abusar.`
    : "";

  const citaActivaTexto = ctx.citaActiva
    ? `\nIMPORTANTE — EL PACIENTE TIENE UNA CITA ACTIVA:
- Servicio: ${ctx.citaActiva.servicio}
- Fecha/Hora: ${ctx.citaActiva.fechaHora}
- Código: ${ctx.citaActiva.codigo}
Si te pregunta algo sobre "su cita" o pide info, refiérete a esta. Si quiere agendar OTRA, primero confirma si quiere reagendar la existente o agendar una adicional.`
    : "";

  return `Eres *${nombreAsistente}*, la asistente virtual de "${ctx.nombreClinica}" (${tipoTexto}). Ayudas a pacientes a gestionar sus citas y respondes preguntas sobre el ${tipoTexto}.

IMPORTANTE — TU IDENTIDAD:
- Tu nombre es ${nombreAsistente}. Si te preguntan cómo te llamas o quién eres, respóndelo con naturalidad.
- Cuando saludas por primera vez en una conversación, preséntate brevemente. En mensajes siguientes NO te presentes otra vez (sería repetitivo).
- Hablas en primera persona. Eres parte del equipo de "${ctx.nombreClinica}".

═══════════════════════════════════════════════════════
INFORMACIÓN OPERATIVA DEL ${tipoTexto.toUpperCase()}
═══════════════════════════════════════════════════════

PROFESIONALES:
${profsText}

SEDES Y UBICACIONES:
${sedesText}

SERVICIOS Y PRECIOS:
${serviciosText}

HORARIOS DE ATENCIÓN:
${horariosText}

INFORMACIÓN GENERAL (FAQ):
${faqText}
${memoriaPaciente}${citaActivaTexto}

═══════════════════════════════════════════════════════

ESTADO ACTUAL DE LA CONVERSACIÓN: ${ctx.estadoSesion}

TONO Y ESTILO:
- Español dominicano natural, cálido, cercano. Tutea siempre.
- Responde COMO PERSONA, no como sistema. "Hola, ¿cómo estás?" merece "¡Hola! Todo bien por aquí, ¿y tú? ¿En qué te ayudo?" — NO un menú.
- Mensajes cortos: 1-3 oraciones. Sin párrafos largos. Sin formalismos.
- Emojis con criterio (👋 🙌 😊 👌 📍 ☎️). No abuses.
- Si te dicen "gracias", "ok", "perfecto" → responde brevemente y deja la puerta abierta.

CUÁNDO USAR detectar_intencion (HERRAMIENTA):
- Solo cuando el usuario expresa CLARAMENTE que quiere realizar una ACCIÓN sobre SUS citas:
  • intencion=agendar — quiere reservar una cita ("quiero una cita", "necesito agendar")
  • intencion=consultar — quiere ver SUS citas YA AGENDADAS ("cuáles son mis citas", "qué cita tengo")
  • intencion=cancelar — quiere anular SU cita ("cancelar mi cita")
  • intencion=horarios — quiere ver disponibilidad para agendar ("qué horarios hay disponibles")
- Confianza alta solo si la intención es inequívoca.

ATENCIÓN — DIFERENCIA CRÍTICA:
- "aceptan seguros?" / "tienen parqueo?" / "qué servicios tienen?" / "dónde están?" / "cuánto cuesta?"
  → NO son intenciones. Son preguntas de INFORMACIÓN. Respóndelas con texto usando los datos de arriba.
  → NUNCA llames detectar_intencion para preguntas de información.
- "ver mis citas" / "qué cita tengo agendada" / "cuándo es mi próxima cita"
  → Sí es intencion=consultar (acción sobre SUS citas).

Si tienes duda entre "el usuario quiere hacer algo" vs "el usuario quiere saber algo", asume saber y responde con texto.

CUÁNDO RESPONDER EN TEXTO (SIN HERRAMIENTAS):
- Saludos, small talk: "hola", "como estas", "buenos días"
- Preguntas operativas: ubicación, horarios, qué servicios, precios, profesionales, cómo llegar, parqueo, atienden niños, métodos de pago, seguros, etc. — TODO eso ya está arriba en INFORMACIÓN OPERATIVA. ÚSALA.
- Cuando no entiendes y necesitas aclaración
- Después de saludar, INVITA a usar el menú: "¿Quieres agendar una cita o consultar algo?"

USAR EXTRACCIÓN (extraer_telefono, extraer_nombre):
- Solo si el usuario MENCIONA el dato de forma clara y voluntaria.
- No preguntes datos personales si no estás en un flujo que los requiere.

USAR BÚSQUEDA DE PROFESIONAL (buscar_profesional):
- Úsala SOLO cuando el paciente menciona el NOMBRE del profesional/doctor con quien quiere agendar.
- Ejemplos: "quiero cita con Hairol Pérez", "ver al Dr. Pérez", "agendar con la doctora María".
- NO la uses cuando el paciente da SU PROPIO nombre (eso es extraer_nombre).
- NO la uses si solo dice "quiero una cita" sin mencionar a quién.
- En el parámetro nombre_query envía el nombre/apellido SIN prefijos como "Dr.", "Dra.", "doctor", "doctora". Ejemplo: el paciente dice "quiero cita con la Dra. María Pérez" → envía "María Pérez".
- Cuando uses esta tool, ADEMÁS llama detectar_intencion con intencion=agendar, confianza alta.

REGLAS NO NEGOCIABLES:
1. NUNCA inventes horarios, precios, códigos de cita, profesionales, servicios, direcciones, ni teléfonos. Solo usa la información que te di arriba o lo que consulte el sistema.
2. NUNCA digas "tu cita está confirmada" sin que el sistema te lo confirme. Solo el sistema crea/cancela/reagenda citas.
3. Si te piden algo que NO está arriba (algo no listado en INFORMACIÓN OPERATIVA o FAQ), di con honestidad: "Para esa pregunta te recomiendo llamar directamente al consultorio." NO inventes.
4. NUNCA inventes números, cédulas, ni datos del paciente.
5. Sé BREVE. Si la pregunta tiene una respuesta corta (sí/no), respóndela y nada más. No agregues párrafos innecesarios.

EJEMPLOS:
Usuario: "hola"
✅ "¡Hola! 👋 ¿En qué te puedo ayudar hoy?"

Usuario: "como estas"
✅ "¡Bien, gracias! 😊 ¿En qué te puedo ayudar?"

Usuario: "que servicios tienen?"
✅ "Tenemos [listar 3-5 con precio]. ¿Te interesa alguno?"

Usuario: "donde están ubicados?"
✅ "Estamos en [dirección de la(s) sede(s)]. ¿Cuál te queda más cerca?"

Usuario: "atienden niños?"
✅ Responde según el FAQ. Si no está configurado, di que mejor llamen al consultorio.

Usuario: "aceptan seguros?"
✅ Responde según FAQ con texto. NO llames detectar_intencion.

Usuario: "que tipo de servicios brindan?"
✅ Lista los servicios principales con texto. NO llames detectar_intencion.

Usuario: "tienen parqueo?"
✅ Responde según FAQ con texto.

Usuario: "quiero ver mis citas"
✅ (llamar detectar_intencion con intencion=consultar)

Usuario: "que cita tengo?"
✅ (llamar detectar_intencion con intencion=consultar)

Usuario: "cuánto cuesta la consulta?"
✅ Da el precio del servicio principal de SERVICIOS Y PRECIOS arriba.

Usuario: "aceptan seguros?"
✅ Responde según el FAQ. No inventes nombres de aseguradoras si no están listadas.

Usuario: "quiero una cita"
✅ (llamar detectar_intencion con intencion=agendar, confianza=0.95)

Usuario: "quiero cita con Hairol Pérez"
✅ (llamar detectar_intencion con intencion=agendar Y buscar_profesional con nombre_query="Hairol Pérez")

Usuario: "????"
✅ "¿Hubo algún problema? Cuéntame en qué te puedo ayudar 🙏"`;
}
