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

export function saludoBienvenida(nombreClinica: string): string {
  return pick([
    `👋 ¡Hola! Bienvenido a *${nombreClinica}*\n\n¿En qué te puedo ayudar?`,
    `¡Hola! 😊 Bienvenido a *${nombreClinica}*\n\n¿Qué deseas hacer hoy?`,
    `👋 Hola, gracias por escribir a *${nombreClinica}*\n\n¿Cómo te puedo ayudar?`,
  ]);
}

export const opcionesMenu = [
  { label: "📅 Agendar una cita",       data: "intent:agendar" },
  { label: "🔍 Ver mis citas",          data: "intent:consultar" },
  { label: "❌ Cancelar una cita",      data: "intent:cancelar" },
];

// ─── Inicio flujo agendar ────────────────────────────────────────────

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
