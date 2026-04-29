// src/application/llm/prompt-builder.ts
// Construye el system prompt con datos REALES del tenant desde la DB.

export interface ProfesionalResumen {
  display: string;
  especialidad?: string;
  bio?: string | null;
  anosExperiencia?: number | null;
  whatsapp?: string | null;
  aseguradoras?: string[];
}

export interface SedeResumen {
  nombre: string;
  ciudad?: string | null;
  direccion?: string | null;
  telefono?: string | null;
  tieneUbicacion?: boolean;
  extension?: string | null;
}

export interface ServicioResumen {
  nombre: string;
  descripcion?: string | null;
  precio?: number;
  duracionMin?: number;
  moneda?: string;
}

export interface HorarioResumen {
  texto: string;
}

export interface CitaActivaResumen {
  servicio: string;
  fechaHora: string;
  codigo: string;
}

export interface FAQTenant {
  atiende_emergencias?: boolean;
  consultas_virtuales?: boolean;
  atiende_ninos?: boolean;
  tiene_parqueo?: boolean;
  tiempo_espera_promedio_min?: number;
  indicaciones_previas?: string;
  puede_enviar_ubicacion?: boolean;
  metodos_pago?: string[];
  aceptan_seguros?: boolean;
  aseguradoras?: string[];
  edad_minima?: number;
  edad_maxima?: number;
  notas_adicionales?: string;
}

export interface PromptContext {
  nombreClinica: string;
  tipoEntidad: "individual" | "clinica";
  profesionales: ProfesionalResumen[];
  sedes: SedeResumen[];
  servicios: ServicioResumen[];
  estadoSesion: string;
  horarios?: HorarioResumen[];
  pacienteNombre?: string;
  citaActiva?: CitaActivaResumen;
  nombreAsistente?: string;
  faq?: FAQTenant;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const tipoTexto = ctx.tipoEntidad === "clinica" ? "clínica" : "consultorio";
  const nombreAsistente = ctx.nombreAsistente ?? "María Salud";

  // ─── Profesionales ────────────────────────────────────────────────
  const profsText = ctx.profesionales.length === 0
    ? "(sin profesionales configurados)"
    : ctx.profesionales.map(p => {
        const partes: string[] = [`- ${p.display}`];
        if (p.especialidad) partes.push(`(${p.especialidad})`);
        if (p.anosExperiencia && p.anosExperiencia > 0) partes.push(`— ${p.anosExperiencia} años de experiencia`);
        let linea = partes.join(" ");
        if (p.bio) linea += `\n   ${p.bio}`;
        if (p.whatsapp) linea += `\n   📱 WhatsApp directo: ${p.whatsapp}`;
        if (p.aseguradoras && p.aseguradoras.length > 0) linea += `\n   💳 Acepta: ${p.aseguradoras.join(", ")}`;
        return linea;
      }).join("\n");

  // ─── Sedes ────────────────────────────────────────────────────────
  const sedesText = ctx.sedes.length === 0
    ? "(sin sedes configuradas)"
    : ctx.sedes.map(s => {
        const partes: string[] = [`- *${s.nombre}*`];
        if (s.ciudad) partes.push(`(${s.ciudad})`);
        let linea = partes.join(" ");
        if (s.direccion) linea += `\n   📍 ${s.direccion}`;
        if (s.telefono) {
          const ext = s.extension ? ` Ext. ${s.extension}` : "";
          linea += `\n   ☎️ ${s.telefono}${ext}`;
        } else if (s.extension) {
          linea += `\n   ☎️ Ext. ${s.extension}`;
        }
        if (s.tieneUbicacion) linea += `\n   📌 Puedes ofrecer enviar la ubicación si te la piden`;
        return linea;
      }).join("\n");

  // ─── Servicios ────────────────────────────────────────────────────
  const serviciosText = ctx.servicios.length === 0
    ? "(consulta el catálogo al usuario)"
    : ctx.servicios.slice(0, 12).map(s => {
        const partes: string[] = [`- *${s.nombre}*`];
        if (s.precio !== undefined && s.precio > 0) {
          partes.push(`— ${s.moneda ?? "DOP"} ${s.precio.toLocaleString()}`);
        }
        if (s.duracionMin) partes.push(`(${s.duracionMin} min)`);
        let linea = partes.join(" ");
        if (s.descripcion) linea += `\n   ${s.descripcion}`;
        return linea;
      }).join("\n");

  // ─── Horarios ─────────────────────────────────────────────────────
  const horariosText = (ctx.horarios && ctx.horarios.length > 0)
    ? ctx.horarios.map(h => `- ${h.texto}`).join("\n")
    : "(no configurados — sugiere llamar al consultorio para confirmar)";

  // ─── FAQ ──────────────────────────────────────────────────────────
  const faq = ctx.faq ?? {};
  const faqLines: string[] = [];
  if (faq.atiende_emergencias !== undefined) {
    faqLines.push(`- Emergencias: ${faq.atiende_emergencias ? "SÍ atienden" : "NO atienden, recomiendan ir a un centro de emergencias"}`);
  }
  if (faq.consultas_virtuales !== undefined) {
    faqLines.push(`- Consultas virtuales: ${faq.consultas_virtuales ? "SÍ disponibles" : "NO, solo presenciales"}`);
  }
  if (faq.atiende_ninos !== undefined) {
    const min = faq.edad_minima;
    const max = faq.edad_maxima;
    let lineaNinos: string;
    if (faq.atiende_ninos) {
      if (min !== undefined && max !== undefined) lineaNinos = `- Niños: SÍ atendemos pacientes de ${min} a ${max} años`;
      else if (min !== undefined) lineaNinos = `- Niños: SÍ atendemos a partir de ${min} años`;
      else if (max !== undefined) lineaNinos = `- Niños: SÍ atendemos hasta los ${max} años`;
      else lineaNinos = `- Niños: SÍ atendemos pacientes pediátricos`;
    } else {
      lineaNinos = min !== undefined
        ? `- Edad mínima de atención: ${min} años — NO atendemos menores de esa edad`
        : `- Niños: NO atendemos pacientes pediátricos. Recomienda buscar un pediatra.`;
    }
    faqLines.push(lineaNinos);
  }
  if (faq.tiene_parqueo !== undefined) faqLines.push(`- Parqueo: ${faq.tiene_parqueo ? "SÍ disponible" : "NO disponible"}`);
  if (faq.tiempo_espera_promedio_min !== undefined) faqLines.push(`- Tiempo de espera promedio: ${faq.tiempo_espera_promedio_min} minutos`);
  if (faq.indicaciones_previas) faqLines.push(`- Indicaciones antes de la consulta: ${faq.indicaciones_previas}`);
  if (faq.puede_enviar_ubicacion) faqLines.push(`- Puedes ofrecer enviar la ubicación por el chat si la piden`);
  if (faq.metodos_pago && faq.metodos_pago.length > 0) faqLines.push(`- Métodos de pago aceptados: ${faq.metodos_pago.join(", ")}`);
  if (faq.aceptan_seguros !== undefined) {
    const segs = faq.aseguradoras && faq.aseguradoras.length > 0 ? ` (${faq.aseguradoras.join(", ")})` : "";
    faqLines.push(`- Seguros médicos: ${faq.aceptan_seguros ? `SÍ aceptan${segs}` : "NO aceptan"}`);
  }
  if (faq.notas_adicionales) faqLines.push(`- Otras notas: ${faq.notas_adicionales}`);
  const faqText = faqLines.length > 0
    ? faqLines.join("\n")
    : "(no configurado — para preguntas que no estén arriba, sugiere llamar al consultorio directamente)";

  // ─── Contexto del paciente ────────────────────────────────────────
  const memoriaPaciente = ctx.pacienteNombre
    ? `\nEL PACIENTE YA TE CONOCE: se llama ${ctx.pacienteNombre}. Salúdalo por su nombre cuando sea natural, sin abusar.`
    : "";

  const citaActivaTexto = ctx.citaActiva
    ? `\nIMPORTANTE — EL PACIENTE TIENE UNA CITA ACTIVA:
- Servicio: ${ctx.citaActiva.servicio}
- Fecha/Hora: ${ctx.citaActiva.fechaHora}
- Código: ${ctx.citaActiva.codigo}
Si pregunta por "su cita", refiérete a esta. Si quiere agendar OTRA, confirma si quiere reagendar o agendar adicional.`
    : "";

  return `Eres *${nombreAsistente}*, la asistente virtual de "${ctx.nombreClinica}" (${tipoTexto}). Ayudas a pacientes a gestionar sus citas y respondes preguntas sobre el ${tipoTexto}.

IMPORTANTE — TU IDENTIDAD:
- Tu nombre es ${nombreAsistente}. Respóndelo con naturalidad si te preguntan.
- Primera vez que conversas: preséntate brevemente. Después NO te presentes otra vez.
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
TONO Y ESTILO
═══════════════════════════════════════════════════════

- Español dominicano natural, cálido, cercano. Tutea siempre.
- Responde COMO PERSONA, no como sistema.
- Mensajes cortos: 1-3 oraciones máximo.
- Emojis con criterio. No abuses.
- Reacciones del paciente ("gracias", "ok", "genial", "excelente", "perfecto") →
  responde brevemente y deja la puerta abierta. NO las trates como búsquedas de doctor.

═══════════════════════════════════════════════════════
HERRAMIENTA: detectar_intencion
═══════════════════════════════════════════════════════

Úsala SOLO cuando el paciente quiere ejecutar una ACCIÓN concreta sobre citas.

INTENCION = "agendar"
  El paciente quiere RESERVAR una cita nueva.
  ✅ "quiero una cita", "necesito agendar", "quiero sacar turno", "quisiera una consulta"
  ✅ "quiero verme con el doctor"
  ❌ NO usar si solo pregunta precios, horarios o información general.

INTENCION = "consultar"
  El paciente quiere VER sus citas ya agendadas.
  ✅ "ver mis citas", "qué cita tengo", "cuándo es mi cita", "tengo alguna cita pendiente"
  ✅ "cuándo me toca", "qué día tengo cita"

INTENCION = "cancelar"
  El paciente quiere ANULAR una cita existente, O reagendar (que implica cancelar la actual).
  ✅ "cancelar mi cita", "quiero cancelar", "me gustaría cancelar"
  ✅ "necesito cancelar", "quisiera anular mi cita", "no puedo ir a mi cita"
  ✅ "quiero reagendar", "quisiera cambiar mi cita", "mover mi cita"
  ✅ Cualquier frase que contenga "cancelar" o "anular" referida a UNA CITA.
  ⚠️ CRÍTICO: "cancelar" SIEMPRE es intencion=cancelar. NUNCA es agendar.

INTENCION = "horarios"
  El paciente quiere ver disponibilidad de slots para agendar.
  ✅ "qué horarios hay", "cuándo tienen disponible", "qué días atienden esta semana"

REGLA DE ORO:
  Si hay duda entre "el paciente quiere HACER algo" vs "quiere SABER algo" →
  asume SABER y responde con texto. Solo usa detectar_intencion cuando la acción es inequívoca.

═══════════════════════════════════════════════════════
HERRAMIENTA: buscar_profesional
═══════════════════════════════════════════════════════

Úsala SOLO cuando el paciente menciona el NOMBRE del doctor con quien quiere agendar.
  ✅ "quiero cita con Hairol Pérez", "ver al Dr. Pérez", "agendar con la doctora María"
  ❌ NO usar si el paciente da SU PROPIO nombre.
  ❌ NO usar si solo dice "quiero una cita" sin mencionar a quién.

Envía el nombre SIN prefijos: "Dr.", "Dra.", "doctor", "doctora".
Cuando la uses, TAMBIÉN llama detectar_intencion con intencion=agendar.

═══════════════════════════════════════════════════════
CUÁNDO RESPONDER SOLO CON TEXTO (sin herramientas)
═══════════════════════════════════════════════════════

- Saludos y small talk → respuesta natural breve.
- Reacciones: "gracias", "ok", "perfecto", "genial", "excelente", "qué bueno" →
  respuesta cálida corta. NUNCA las interpretes como búsqueda de doctor.
- Preguntas de información (ubicación, horarios, precios, servicios, seguros, parqueo) →
  responde usando los datos de INFORMACIÓN OPERATIVA arriba.
- Cuando no hay intención clara de acción → responde con texto.

REGLAS NO NEGOCIABLES:
1. NUNCA inventes horarios, precios, códigos, profesionales, servicios ni teléfonos.
2. NUNCA digas "tu cita está confirmada" sin que el sistema lo confirme.
3. Si algo no está en INFORMACIÓN OPERATIVA: "Te recomiendo llamar directamente al consultorio."
4. Sé BREVE. Respuesta corta si la pregunta es corta.

═══════════════════════════════════════════════════════
EJEMPLOS
═══════════════════════════════════════════════════════

"hola"
→ "¡Hola! 👋 ¿En qué te puedo ayudar hoy?"

"como estas"
→ "¡Bien, gracias! 😊 ¿En qué te puedo ayudar?"

"genial" / "excelente" / "ok gracias" / "perfecto"
→ "Con gusto 😊 ¿Hay algo más en que te pueda ayudar?"

"que servicios tienen?"
→ Lista servicios con precio. Sin herramientas.

"aceptan seguros?"
→ Responde según FAQ. Sin herramientas.

"donde están ubicados?"
→ Responde con la dirección de las sedes. Sin herramientas.

"quiero una cita" / "necesito agendar"
→ detectar_intencion(intencion="agendar", confianza=0.95)

"quiero cita con Hairol Pérez"
→ detectar_intencion(intencion="agendar", confianza=0.95) + buscar_profesional(nombre_query="Hairol Pérez")

"ver mis citas" / "qué cita tengo?"
→ detectar_intencion(intencion="consultar", confianza=0.95)

"me gustaría cancelar" / "quiero cancelar mi cita" / "necesito cancelar"
→ detectar_intencion(intencion="cancelar", confianza=0.95)

"quiero reagendar" / "quisiera cambiar mi cita"
→ detectar_intencion(intencion="cancelar", confianza=0.88)

"no puedo ir a mi cita"
→ detectar_intencion(intencion="cancelar", confianza=0.90)

"????"
→ "¿Hubo algún problema? Cuéntame en qué te puedo ayudar 🙏"`;
}
