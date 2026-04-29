// src/application/messages.ts
// Plantillas de mensajes con tono cálido dominicano.
// Variantes aleatorias para que el bot no suene robótico.
//
// Reglas de tono:
//   - Tutea al paciente
//   - Profesional pero cercano
//   - Frases naturales: "claro que sí", "perfecto", "déjame ver", "listo"
//   - Mensajes cortos (1-3 oraciones)
//   - Emojis sutiles donde tienen sentido
//   - Sin "Estimado paciente" ni formalismos rígidos

/** Elige una variante al azar. */
function pick<T>(opts: T[]): T {
  return opts[Math.floor(Math.random() * opts.length)];
}

// ─── Saludos / menú principal ────────────────────────────────────────

/** Nombre por defecto de la asistente virtual. Configurable por tenant. */
export const ASISTENTE_NOMBRE_DEFAULT = "María Salud";

/**
 * Saludo de bienvenida a CitasMed (la plataforma).
 * María Salud no es de un consultorio: es de CitasMed y atiende a pacientes
 * de TODOS los doctores que estén registrados. El usuario llega con un nombre
 * o teléfono específico de su doctor en mente.
 */
/** Disclaimer médico obligatorio (Spec v1.1 sec 4.2). Debe aparecer en el
 *  primer mensaje de cada conversación nueva con un paciente.
 *  NO se modifica caprichosamente — es texto legalmente sensible.
 */
export const DISCLAIMER_MEDICO =
  "⚠️ Solo te ayudo a *agendar citas* e información del consultorio. " +
  "*No doy consejos médicos ni atiendo emergencias.* " +
  "Si tienes una emergencia médica, llama al 911.";

/**
 * Saludo inicial de CitasMed para paciente que llega sin contexto de doctor.
 * SIEMPRE incluye el disclaimer médico (es el primer contacto).
 */
export function saludoCitasMed(
  nombreAsistente: string = ASISTENTE_NOMBRE_DEFAULT,
): string {
  return pick([
    `👋 ¡Hola! Bienvenido(a) a *CitasMed*.\nSoy *${nombreAsistente}*, tu asistente.\n\n${DISCLAIMER_MEDICO}\n\nPara empezar, dime el *nombre, apellido o teléfono* del especialista con quien deseas agendar.`,
    `¡Hola! 🤍 Soy *${nombreAsistente}* de *CitasMed*.\n\n${DISCLAIMER_MEDICO}\n\nDime el nombre, apellido o teléfono de tu especialista y agendamos tu cita.`,
    `👋 Bienvenido(a) a *CitasMed*. Te atiende *${nombreAsistente}* 🙌\n\n${DISCLAIMER_MEDICO}\n\n¿Con cuál especialista deseas agendar? Dime su *nombre, apellido o teléfono*.`,
  ]);
}

/**
 * Saludo cuando el paciente llega vía link único de un doctor (deep link
 * `/start <slug>`). Lleva disclaimer + ya menciona al doctor específico.
 */
export function saludoCitasMedConDoctor(
  doctorDisplay: string,
  especialidad: string | null,
  nombreAsistente: string = ASISTENTE_NOMBRE_DEFAULT,
): string {
  const espTexto = especialidad ? ` 🩺 ${especialidad}` : "";
  return `👋 ¡Hola! Soy *${nombreAsistente}*, asistente virtual de *CitasMed*.\n\n${DISCLAIMER_MEDICO}\n\nVas a gestionar tu cita con *${doctorDisplay}*${espTexto}\n\n¿Qué deseas hacer?`;
}

export const opcionesMenuConDoctor = (profesionalId: string) => [
  { label: "📅 Agendar cita",            data: `agendar_con:${profesionalId}` },
  { label: "📋 Ver mis citas",           data: "intent:consultar" },
  { label: "❌ Cancelar/Reagendar",      data: "intent:cancelar" },
  { label: "ℹ️ Información",             data: `info_doctor:${profesionalId}` },
];

/** Confirmación tras encontrar UN solo doctor por búsqueda inicial. */
export function confirmarDoctorEncontrado(displayDoctor: string, especialidad: string | null): string {
  const espTexto = especialidad ? `\n🩺 ${especialidad}` : "";
  return pick([
    `Encontré a *${displayDoctor}*${espTexto}\n\n¿Deseas agendar con ${displayDoctor.startsWith("Dra.") ? "ella" : "él"}?`,
    `*${displayDoctor}*${espTexto}\n\n¿Vamos a agendar contigo? 😊`,
    `Listo, ${displayDoctor}${espTexto}\n\n¿Confirmamos para agendar?`,
  ]);
}

export const opcionesConfirmarDoctor = (profesionalId: string) => [
  { label: "✅ Sí, agendar",         data: `agendar_con:${profesionalId}` },
  { label: "🔍 Buscar otro",         data: "buscar_otro" },
];

/** Cuando hay varios matches, mostramos botones para que el usuario elija. */
export function variosDoctoresEncontrados(): string {
  return pick([
    `Encontré varios especialistas con ese nombre. ¿Cuál es?`,
    `Hay varios resultados, dime cuál:`,
    `Encontré más de uno. Elige a tu especialista:`,
  ]);
}

/** Cuando no encuentra ningún doctor con la búsqueda. */
export function doctorNoEncontrado(textoBusqueda: string): string {
  return pick([
    `No encuentro a ningún especialista con "${textoBusqueda}" 🤔\n\nDame su nombre completo, apellido o teléfono y lo busco de nuevo.`,
    `Hmm, no encuentro a nadie con "${textoBusqueda}". ¿Puedes darme su nombre completo o su WhatsApp?`,
    `No tengo a ningún especialista que coincida con "${textoBusqueda}".\n\nIntenta con su apellido o número de teléfono. 😊`,
  ]);
}

export function saludoBienvenida(
  nombreClinica: string,
  nombreAsistente: string = ASISTENTE_NOMBRE_DEFAULT,
): string {
  return pick([
    `👋 ¡Hola! Bienvenido(a) a *${nombreClinica}*\nSoy *${nombreAsistente}* 🤍 ¿En qué te puedo ayudar hoy?`,
    `¡Hola! 😊 Bienvenido(a) a *${nombreClinica}*\nSoy *${nombreAsistente}*, tu asistente. ¿Qué deseas hacer?`,
    `👋 Hola, gracias por escribir a *${nombreClinica}*\nTe atiende *${nombreAsistente}* 🙌 ¿Cómo te ayudo?`,
  ]);
}

/** Saludo cuando el paciente YA tiene una cita activa con nosotros. */
export function saludoConCitaPendiente(
  nombreClinica: string,
  fechaHora: string,
  servicio: string,
  nombreAsistente: string = ASISTENTE_NOMBRE_DEFAULT,
): string {
  return pick([
    `👋 ¡Hola de nuevo! Soy *${nombreAsistente}* de *${nombreClinica}*. Te tengo registrado con cita:\n\n📅 *${servicio}*\n🕒 ${fechaHora}\n\n¿En qué te ayudo?`,
    `¡Hola! 😊 Te saluda *${nombreAsistente}*. Veo que ya tienes una cita con nosotros:\n\n📅 *${servicio}* — ${fechaHora}\n\n¿Qué necesitas?`,
    `Hola otra vez 🙌 Soy *${nombreAsistente}*. Tu próxima cita en *${nombreClinica}* es:\n📅 ${servicio} — ${fechaHora}\n\n¿Cómo te ayudo hoy?`,
  ]);
}

export const opcionesMenu = [
  { label: "📅 Agendar una cita",       data: "intent:agendar" },
  { label: "🔍 Ver mis citas",          data: "intent:consultar" },
  { label: "❌ Cancelar una cita",      data: "intent:cancelar" },
];

export const opcionesMenuConCitaPendiente = [
  { label: "🔍 Ver mi cita",            data: "intent:consultar" },
  { label: "❌ Cancelar mi cita",        data: "intent:cancelar" },
  { label: "📅 Agendar otra cita",       data: "intent:agendar" },
];

/** Cuando el usuario quiere agendar pero ya tiene una cita activa. */
export function yaTienesCitaActiva(fechaHora: string, servicio: string, codigo: string): string {
  return pick([
    `Antes de agendar otra: ya tienes una cita activa.\n\n📅 *${servicio}*\n🕒 ${fechaHora}\n🎫 ${codigo}\n\n¿Quieres reagendar esa o agendar una adicional?`,
    `Ojo 👀 Ya tienes una cita registrada:\n\n📅 *${servicio}* — ${fechaHora}\n🎫 ${codigo}\n\n¿Es esa la que querías o necesitas otra cita más?`,
  ]);
}

export const opcionesYaTieneCita = [
  { label: "✅ Esa está bien, gracias",  data: "menu:inicio" },
  { label: "❌ Cancelar esa cita",        data: "intent:cancelar" },
  { label: "➕ Agendar otra adicional",   data: "intent:agendar_otra" },
];

// ─── Inicio flujo agendar ────────────────────────────────────────────

export function eligiendoProfesional(): string {
  return pick([
    `¡Claro que sí, te ayudo a agendar! 🙌\n\n¿Con cuál profesional quieres tu cita?`,
    `Perfecto. Tenemos varios profesionales. ¿Con quién prefieres agendar?`,
    `Listo, vamos a agendar 👨‍⚕️ ¿A cuál profesional deseas ver?`,
  ]);
}

export function eligiendoSede(profesional: string): string {
  return pick([
    `Claro que sí, te ayudo a agendar con *${profesional}* 👨‍⚕️\n\n¿En cuál sede te queda mejor?`,
    `¡Perfecto! Vas a agendar con *${profesional}* 👨‍⚕️\n\n¿En qué sede prefieres ser atendido?`,
    `Listo, agendamos con *${profesional}* 👨‍⚕️\n\n¿Cuál sede te conviene más?`,
  ]);
}

// ─── Eligiendo servicio ──────────────────────────────────────────────

export function eligiendoServicio(): string {
  return pick([
    `Buena elección 🙌 Ahora dime, ¿qué servicio necesitas?`,
    `Perfecto. ¿Qué servicio vas a necesitar?`,
    `Excelente. ¿Cuál servicio deseas agendar?`,
  ]);
}

// ─── Eligiendo día ───────────────────────────────────────────────────

export function eligiendoDia(servicioNombre: string, precio: number, duracionMin: number): string {
  return pick([
    `Anotado: *${servicioNombre}*\n💰 RD$${precio.toLocaleString()} · ⏱ ${duracionMin} min\n\n¿Para qué día?`,
    `Listo: *${servicioNombre}* (RD$${precio.toLocaleString()}, ${duracionMin} min)\n\n¿Qué día te queda bien?`,
    `Perfecto: *${servicioNombre}* — RD$${precio.toLocaleString()} (${duracionMin} min)\n\n¿Cuál día prefieres?`,
  ]);
}

// ─── Eligiendo hora ──────────────────────────────────────────────────

export function eligiendoHora(fechaDisplay: string): string {
  return pick([
    `Estos son los horarios disponibles para *${fechaDisplay}*:`,
    `Para *${fechaDisplay}* tengo estas horas libres:`,
    `Déjame ver... aquí están las horas disponibles para *${fechaDisplay}*:`,
  ]);
}

export function diaSinHorarios(fechaDisplay: string): string {
  return pick([
    `Uy, no me quedan horarios libres para *${fechaDisplay}* 😕\n\nElige otro día:`,
    `Para *${fechaDisplay}* ya no hay cupos disponibles.\n\n¿Qué tal otro día?`,
    `Lamentablemente *${fechaDisplay}* está completo. Prueba con otro día:`,
  ]);
}

// ─── Pidiendo nombre ─────────────────────────────────────────────────

export function pidiendoNombre(): string {
  return pick([
    `Excelente 🙌 Para terminar de agendar necesito tu *nombre completo*. ¿Me lo escribes?`,
    `¡Listo! Solo me faltan unos datos. ¿Cuál es tu *nombre completo*?`,
    `Casi terminamos. ¿Me dices tu *nombre completo*?`,
  ]);
}

export function nombreInvalido(razon: string): string {
  return pick([
    `Hmm, ${razon}. Por favor escríbeme tu nombre completo.`,
    `${razon}. Inténtalo de nuevo, escribe tu nombre completo.`,
  ]);
}

// ─── Pidiendo teléfono ───────────────────────────────────────────────

export function pidiendoTelefonoAgenda(nombrePaciente: string): string {
  return pick([
    `Gracias, *${nombrePaciente}* 🙌 Ahora dime tu *teléfono* (ej: 8094563214).`,
    `Perfecto, *${nombrePaciente}*. ¿Cuál es tu *teléfono*? (formato 8094563214)`,
    `Listo, *${nombrePaciente}*. ¿Me das tu *número de teléfono*?`,
  ]);
}

export function pidiendoTelefonoConsulta(): string {
  return pick([
    `Claro, déjame buscar. ¿Cuál es tu *teléfono*?`,
    `Para buscar tus citas, dame tu *teléfono* (ej: 8094563214).`,
    `Dime tu *número de teléfono* y busco tus citas.`,
  ]);
}

export function pidiendoTelefonoCancelar(): string {
  return pick([
    `Claro, te ayudo. Dame tu *teléfono* y veo qué citas tienes.`,
    `Para cancelar, primero dime tu *teléfono* (ej: 8094563214).`,
  ]);
}

export function telefonoInvalido(razon: string): string {
  return pick([
    `Mmm, ${razon}. Escríbelo de nuevo (ej: 8094563214).`,
    `${razon}. Inténtalo así: 8094563214`,
  ]);
}

// ─── Tipo de pago ────────────────────────────────────────────────────

export function eligiendoTipoPago(): string {
  return pick([
    `Genial. Una última cosa: ¿cómo deseas pagar?`,
    `Casi listo 🙌 ¿Cuál es tu forma de pago?`,
    `Ya casi terminamos. ¿Cómo vas a pagar?`,
  ]);
}

export const opcionesTipoPago = [
  { label: "💵 Efectivo",       data: "tipopago:efectivo" },
  { label: "💳 Tarjeta",        data: "tipopago:tarjeta" },
  { label: "🏦 Transferencia",  data: "tipopago:transferencia" },
];

// ─── Confirmación ────────────────────────────────────────────────────

export function resumenConfirmacion(
  nombre: string,
  apellido: string,
  telefono: string,
  servicio: string,
  fechaHora: string,
  precio: number,
  tipoPago: string
): string {
  const nombreCompleto = apellido ? `${nombre} ${apellido}` : nombre;
  return (
    `*Antes de confirmar, revisa los datos:*\n\n` +
    `👤 ${nombreCompleto}\n` +
    `📱 ${telefono}\n` +
    `🏥 ${servicio}\n` +
    `📅 ${fechaHora}\n` +
    `💰 RD$${precio.toLocaleString()} (${tipoPago})\n\n` +
    `¿Todo correcto?`
  );
}

export const opcionesConfirmacion = [
  { label: "✅ Sí, confirmar",   data: "confirmar:si" },
  { label: "❌ No, cancelar",    data: "menu:inicio" },
];

// ─── Cita confirmada ─────────────────────────────────────────────────

export function citaConfirmada(codigo: string): string {
  return pick([
    `🎉 ¡Listo! Tu cita está confirmada\n\n` +
      `Código: *${codigo}*\n\n` +
      `Guarda este código por si necesitas consultarla o cambiarla luego.\n\n` +
      `_Para volver al menú: /start_`,
    `✅ ¡Cita confirmada!\n\n` +
      `Tu código es *${codigo}*\n\n` +
      `Guárdalo bien — te servirá si necesitas modificar o cancelar la cita.\n\n` +
      `_Para volver al menú: /start_`,
    `🙌 Todo listo, tu cita quedó agendada\n\n` +
      `Código: *${codigo}*\n\n` +
      `Ese código es importante para futuras consultas. ¡Te esperamos!\n\n` +
      `_Para volver al menú: /start_`,
  ]);
}

// ─── Errores con propósito (no genéricos) ────────────────────────────

export function errorAgendar(razon: string): string {
  // razon viene de DomainError.message, ya en español
  return `❌ ${razon}\n\nPuedes intentar de nuevo con otra opción.`;
}

export function errorTecnico(): string {
  return pick([
    `Algo no funcionó del lado nuestro 😕\nIntenta de nuevo en un momento. Si persiste, llámanos al consultorio.`,
    `Tuve un problema técnico. Inténtalo otra vez en unos segundos.`,
  ]);
}

export const botonVolverMenu = [
  { label: "🏠 Volver al menú", data: "menu:inicio" },
];

// ─── Consultar/cancelar citas ────────────────────────────────────────

export function sinCitasActivas(): string {
  return pick([
    `No te encontré citas activas con ese teléfono 🤔\n\n¿Quieres agendar una?`,
    `No tengo citas activas registradas con ese número.\n\n¿Te gustaría agendar?`,
  ]);
}

export function citasActivasResumen(citas: Array<{ codigo: string; fechaHora: string; servicio: string }>): string {
  const lineas = citas.map(c =>
    `• *${c.codigo}*\n  📅 ${c.fechaHora}\n  🏥 ${c.servicio}`
  ).join("\n\n");
  return `Estas son tus citas activas:\n\n${lineas}`;
}

export function eligeCitaCancelar(): string {
  return `\n\n¿Cuál deseas cancelar?`;
}

export function citaCancelada(): string {
  return pick([
    `✅ Cita cancelada con éxito.\n\n_/start para volver al menú_`,
    `Listo, cita cancelada 👍\n\n_Usa /start para volver al menú_`,
  ]);
}

// ─── Texto libre / fuera de flujo ────────────────────────────────────

export function noEntendi(): string {
  return pick([
    `Mmm, no estoy seguro de qué necesitas. Pulsa una opción del menú o escribe /start.`,
    `Disculpa, no te entendí bien. Te muestro el menú:`,
  ]);
}

export function reseteoConfirmar(): string {
  return `Tienes una cita en proceso. ¿Quieres cancelar lo que ibas haciendo y empezar de nuevo?`;
}

export const opcionesReseteo = [
  { label: "Sí, empezar de nuevo", data: "reset:si" },
  { label: "No, continuar",        data: "reset:no" },
];

export function flujoCancelado(): string {
  return pick([
    `Listo, dejé de lado lo anterior. ¿En qué te puedo ayudar?`,
    `Sin problema, empezamos de cero 👌`,
  ]);
}

// ─── Cortesía / cierre conversacional ────────────────────────────────

export function respuestaCortesia(): string {
  return pick([
    `¡Con gusto! 😊`,
    `¡A ti! 🙌`,
    `Para servirte 👌`,
    `¡De nada! Cualquier cosa, aquí estoy.`,
  ]);
}

// ─── Frustración / 3 strikes ─────────────────────────────────────────

export function ofrecerSalida(): string {
  return pick([
    `Disculpa si no te entiendo bien 😔 Déjame ayudarte de otra forma.`,
    `Perdona la torpeza. Mejor toca un botón abajo para ayudarte:`,
    `Lo siento, parece que no nos estamos entendiendo. Te muestro las opciones:`,
  ]);
}
