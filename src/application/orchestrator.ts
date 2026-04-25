// src/application/orchestrator.ts
// El cerebro del bot. Recibe IncomingMessage, decide qué hacer, devuelve OutgoingMessage.
//
// Diseño:
//   - Máquina de estados (FSM) sobre la sesión persistida.
//   - LLM solo para interpretar texto libre (intención + extraer entidades).
//   - Botones inline para todas las decisiones críticas (sede, servicio, hora, confirmar).
//   - Cada caso de uso (agendar, cancelar) es una llamada atómica al backend.

import { sessionManager } from "./session-manager.js";
import { callLLM, buildSystemPrompt, ALL_TOOLS } from "./llm/index.js";
import type { LLMTurn } from "./llm/index.js";
import {
  agendarCita,
  listarHorariosLibres,
  consultarCitasActivasPorTelefono,
  cancelarCita,
} from "./use-cases/index.js";
import {
  profesionalesRepo,
  tenantsRepo,
} from "../persistence/repositories/index.js";
import { validatePhoneDO, validateName } from "../domain/validators/index.js";
import { DomainError } from "../domain/errors.js";
import type { IncomingMessage, OutgoingMessage } from "../channels/core/types.js";

/**
 * Procesa un mensaje entrante. Devuelve mensaje saliente.
 * El adapter lo enviará al canal correspondiente.
 */
export async function handleIncoming(msg: IncomingMessage): Promise<OutgoingMessage[]> {
  // 1. Cargar/crear sesión
  const sesion = await sessionManager.loadOrCreate({
    tenantId: msg.tenantId,
    canalConectadoId: msg.channelId,
    contactoExterno: msg.contactoExterno,
  });

  // 2. Comandos especiales: /start, /cancelar reset
  if (msg.type === "command") {
    if (msg.command === "start" || msg.command === "menu") {
      await sessionManager.resetToIdle(sesion.id);
      return [await menuPrincipal(msg.tenantId)];
    }
    if (msg.command === "cancelar" || msg.command === "salir") {
      await sessionManager.resetToIdle(sesion.id);
      return [{ kind: "text", text: "Listo, conversación reiniciada. ¿En qué puedo ayudarte? Usa /start para volver al menú." }];
    }
  }

  // 3. Click de botón → flujo determinístico (sin LLM)
  if (msg.type === "button_click" && msg.buttonData) {
    return await handleButton(msg, sesion);
  }

  // 4. Texto libre → LLM clasifica intención + orchestration
  if (msg.type === "text" && msg.text) {
    return await handleText(msg, sesion);
  }

  return [{ kind: "text", text: "No entendí ese mensaje. Usa /start para volver al menú." }];
}


// ─── BOTONES (decisiones determinísticas) ───────────────────────────

async function handleButton(
  msg: IncomingMessage,
  sesion: { id: string; contexto: Record<string, unknown> }
): Promise<OutgoingMessage[]> {
  const data = msg.buttonData!;
  // Convención de callback_data: "tipo:valor"
  const [tipo, valor] = data.split(":", 2);

  switch (tipo) {
    case "intent":
      return await handleIntentButton(msg, sesion, valor);
    case "sede":
      return await handleSedeButton(msg, sesion, valor);
    case "servicio":
      return await handleServicioButton(msg, sesion, valor);
    case "fecha":
      return await handleFechaButton(msg, sesion, valor);
    case "slot":
      return await handleSlotButton(msg, sesion, valor);
    case "tipopago":
      return await handleTipoPagoButton(msg, sesion, valor);
    case "confirmar":
      return await handleConfirmar(msg, sesion, valor);
    case "cancelar_cita":
      return await handleCancelarCitaButton(msg, sesion, valor);
    case "menu":
      await sessionManager.resetToIdle(sesion.id);
      return [await menuPrincipal(msg.tenantId)];
    default:
      return [{ kind: "text", text: "Opción no reconocida. Usa /start para volver al menú." }];
  }
}


async function handleIntentButton(
  msg: IncomingMessage,
  sesion: { id: string },
  valor: string
): Promise<OutgoingMessage[]> {
  if (valor === "agendar") {
    return await iniciarFlujoAgendar(msg, sesion);
  }
  if (valor === "horarios") {
    return await iniciarFlujoAgendar(msg, sesion);  // mismo flujo
  }
  if (valor === "consultar") {
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "consultar" });
    return [{ kind: "text", text: "Escríbeme tu número de teléfono para buscar tus citas." }];
  }
  if (valor === "cancelar") {
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "cancelar" });
    return [{ kind: "text", text: "Escríbeme tu número de teléfono para buscar tus citas y cancelar la que necesites." }];
  }
  return [{ kind: "text", text: "Opción no reconocida." }];
}


async function iniciarFlujoAgendar(
  msg: IncomingMessage,
  sesion: { id: string }
): Promise<OutgoingMessage[]> {
  // Listar sedes del tenant
  const profesionales = await profesionalesRepo.listarActivos(msg.tenantId);
  if (profesionales.length === 0) {
    return [{ kind: "text", text: "No hay profesionales disponibles en este momento." }];
  }
  const profesional = profesionales[0];   // por ahora 1 doctor — Dr. Hairol Pérez

  const sedes = await profesionalesRepo.listarSedesPorProfesional(msg.tenantId, profesional.id);
  if (sedes.length === 0) {
    return [{ kind: "text", text: "No hay sedes disponibles." }];
  }

  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_SEDE", {
    profesional_id: profesional.id,
  });

  return [{
    kind: "buttons",
    text: `Vas a agendar con ${profesional.prefijo} ${profesional.nombre} ${profesional.apellido}.\n\n¿En qué sede prefieres ser atendido?`,
    buttons: sedes.map(s => ({
      label: s.sede.nombre,
      data: `sede:${s.profesionalSede.id}`,
    })),
  }];
}


async function handleSedeButton(
  _msg: IncomingMessage,
  sesion: { id: string; contexto: Record<string, unknown> },
  psId: string
): Promise<OutgoingMessage[]> {
  const ps = await profesionalesRepo.findProfesionalSedeById(psId);
  if (!ps) return [{ kind: "text", text: "Sede no encontrada. Usa /start." }];

  const servicios = await profesionalesRepo.listarServiciosPublicos(psId);
  if (servicios.length === 0) {
    return [{ kind: "text", text: "Esta sede no tiene servicios disponibles." }];
  }

  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_SERVICIO", {
    profesional_sede_id: psId,
    sede_id: ps.sede_id,
  });

  return [{
    kind: "list",
    text: "Selecciona el servicio:",
    options: servicios.slice(0, 10).map(s => ({
      label: `${s.nombre} — RD$${s.precio.toLocaleString()}`,
      description: `${s.duracion_min} min`,
      data: `servicio:${s.id}`,
    })),
  }];
}


async function handleServicioButton(
  _msg: IncomingMessage,
  sesion: { id: string; contexto: Record<string, unknown> },
  servicioId: string
): Promise<OutgoingMessage[]> {
  const servicio = await profesionalesRepo.findServicioById(servicioId);
  if (!servicio) return [{ kind: "text", text: "Servicio no encontrado." }];

  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_HORA", {
    servicio_id: servicioId,
    servicio_nombre: servicio.nombre,
    servicio_precio: servicio.precio,
  });

  // Mostrar próximos 5 días hábiles
  const diasOpciones = generarProximosDiasHabiles(5);

  return [{
    kind: "buttons",
    text: `Servicio: *${servicio.nombre}*\nPrecio: RD$${servicio.precio.toLocaleString()}\nDuración: ${servicio.duracion_min} min\n\n¿Para qué día?`,
    buttons: diasOpciones.map(d => ({
      label: d.label,
      data: `fecha:${d.iso}`,
    })),
  }];
}


async function handleFechaButton(
  _msg: IncomingMessage,
  sesion: { id: string; contexto: Record<string, unknown> },
  fecha: string
): Promise<OutgoingMessage[]> {
  const psId = sesion.contexto["profesional_sede_id"] as string | undefined;
  if (!psId) return [{ kind: "text", text: "Sesión expirada. Usa /start." }];

  const slots = await listarHorariosLibres({
    profesionalSedeId: psId,
    fecha,
  });

  if (slots.length === 0) {
    return [{
      kind: "buttons",
      text: `No hay horarios libres para ${formatFechaDisplay(fecha)}.\n\nElige otra fecha:`,
      buttons: generarProximosDiasHabiles(5).map(d => ({ label: d.label, data: `fecha:${d.iso}` })),
    }];
  }

  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_HORA", {
    fecha_seleccionada: fecha,
  });

  // Máx 8 botones para no saturar UI
  return [{
    kind: "buttons",
    text: `Horarios disponibles para *${formatFechaDisplay(fecha)}*:\n\nElige una hora:`,
    buttons: slots.slice(0, 8).map(s => ({
      label: s.horaDisplay,
      data: `slot:${s.iniciaEn}`,
    })),
  }];
}


async function handleSlotButton(
  _msg: IncomingMessage,
  sesion: { id: string; contexto: Record<string, unknown> },
  iniciaEn: string
): Promise<OutgoingMessage[]> {
  await sessionManager.transitionTo(sesion.id, "PIDIENDO_NOMBRE", {
    inicia_en: iniciaEn,
  });

  return [{
    kind: "text",
    text: "Excelente. Para confirmar la cita necesito tu *nombre completo*. Escríbelo, por favor.",
  }];
}


async function handleTipoPagoButton(
  _msg: IncomingMessage,
  sesion: { id: string; contexto: Record<string, unknown> },
  tipo: string
): Promise<OutgoingMessage[]> {
  if (!["efectivo", "tarjeta", "transferencia"].includes(tipo)) {
    return [{ kind: "text", text: "Tipo de pago no soportado. Por ahora solo efectivo." }];
  }

  await sessionManager.transitionTo(sesion.id, "CONFIRMANDO", { tipo_pago: tipo });

  return [await renderConfirmacion(sesion.contexto, tipo)];
}


async function renderConfirmacion(
  ctx: Record<string, unknown>,
  tipoPago: string
): Promise<OutgoingMessage> {
  const nombre = ctx["paciente_nombre"] as string;
  const apellido = (ctx["paciente_apellido"] as string) ?? "";
  const tel = ctx["paciente_telefono"] as string;
  const servicioNombre = ctx["servicio_nombre"] as string;
  const precio = ctx["servicio_precio"] as number;
  const iniciaEn = ctx["inicia_en"] as string;

  const fechaHora = formatFechaHoraDisplay(iniciaEn);

  return {
    kind: "buttons",
    text:
      `*Resumen de tu cita:*\n\n` +
      `👤 ${nombre} ${apellido}\n` +
      `📱 ${tel}\n` +
      `🏥 ${servicioNombre}\n` +
      `📅 ${fechaHora}\n` +
      `💰 RD$${precio.toLocaleString()} (${tipoPago})\n\n` +
      `¿Confirmas?`,
    buttons: [
      { label: "✅ Confirmar", data: "confirmar:si" },
      { label: "❌ Cancelar", data: "menu:inicio" },
    ],
  };
}


async function handleConfirmar(
  msg: IncomingMessage,
  sesion: { id: string; contexto: Record<string, unknown> },
  valor: string
): Promise<OutgoingMessage[]> {
  if (valor !== "si") {
    await sessionManager.resetToIdle(sesion.id);
    return [{ kind: "text", text: "Cita cancelada. Usa /start para volver al menú." }];
  }

  const ctx = sesion.contexto;
  try {
    const result = await agendarCita({
      tenantId: msg.tenantId,
      profesionalSedeId: ctx["profesional_sede_id"] as string,
      servicioId: ctx["servicio_id"] as string,
      iniciaEn: ctx["inicia_en"] as string,
      canalOrigen: "telegram",
      pacienteTelefono: ctx["paciente_telefono"] as string,
      pacienteNombre: ctx["paciente_nombre"] as string,
      pacienteApellido: (ctx["paciente_apellido"] as string) ?? "",
      tipoPago: (ctx["tipo_pago"] as "efectivo" | "tarjeta" | "transferencia") ?? "efectivo",
    });

    await sessionManager.resetToIdle(sesion.id);

    return [{
      kind: "text",
      text:
        `✅ *Cita confirmada*\n\n` +
        `Código: *${result.codigo}*\n\n` +
        `Guarda este código por si necesitas consultarla o cancelarla luego.\n\n` +
        `Para volver al menú: /start`,
    }];
  } catch (err) {
    await sessionManager.resetToIdle(sesion.id);
    if (err instanceof DomainError) {
      return [{
        kind: "buttons",
        text: `❌ ${err.message}\n\n¿Qué deseas hacer?`,
        buttons: [
          { label: "Volver al menú", data: "menu:inicio" },
        ],
      }];
    }
    throw err;
  }
}


async function handleCancelarCitaButton(
  msg: IncomingMessage,
  sesion: { id: string },
  citaId: string
): Promise<OutgoingMessage[]> {
  try {
    await cancelarCita({
      tenantId: msg.tenantId,
      citaId,
      motivo: "cancelada por paciente vía bot",
    });
    await sessionManager.resetToIdle(sesion.id);
    return [{ kind: "text", text: "✅ Cita cancelada exitosamente. Usa /start para volver al menú." }];
  } catch (err) {
    if (err instanceof DomainError) {
      return [{ kind: "text", text: `❌ ${err.message}` }];
    }
    throw err;
  }
}


// ─── TEXTO LIBRE (LLM) ──────────────────────────────────────────────

async function handleText(
  msg: IncomingMessage,
  sesion: { id: string; estado: string; contexto: Record<string, unknown> }
): Promise<OutgoingMessage[]> {
  await sessionManager.appendUser(sesion.id, msg.text!);

  // Estados que esperan input específico (no LLM, validación directa)
  if (sesion.estado === "PIDIENDO_NOMBRE") {
    return await handlePidiendoNombre(msg, sesion);
  }
  if (sesion.estado === "PIDIENDO_TELEFONO") {
    return await handlePidiendoTelefono(msg, sesion);
  }

  // Estado IDLE → usar LLM para detectar intención
  if (sesion.estado === "IDLE") {
    return await handleIdleConLLM(msg, sesion);
  }

  // Default: volver al menú
  return [await menuPrincipal(msg.tenantId)];
}


async function handlePidiendoNombre(
  msg: IncomingMessage,
  sesion: { id: string; contexto: Record<string, unknown> }
): Promise<OutgoingMessage[]> {
  const val = validateName(msg.text!);
  if (!val.valid) {
    return [{ kind: "text", text: `${val.reason}. Por favor escribe tu nombre completo.` }];
  }

  await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", {
    paciente_nombre: val.nombre,
    paciente_apellido: val.apellido,
  });

  return [{ kind: "text", text: `Gracias, ${val.nombre}. Ahora escríbeme tu *teléfono* (formato: 8094563214 o +18094563214).` }];
}


async function handlePidiendoTelefono(
  msg: IncomingMessage,
  sesion: { id: string; contexto: Record<string, unknown> }
): Promise<OutgoingMessage[]> {
  const phone = validatePhoneDO(msg.text!);
  if (!phone.valid || !phone.normalized) {
    return [{ kind: "text", text: `${phone.reason}. Escribe un teléfono dominicano válido (ej: 8094563214).` }];
  }

  // ¿Estamos en flujo de consultar/cancelar? Si sí, buscar citas.
  const intencion = sesion.contexto["intencion"];
  if (intencion === "consultar" || intencion === "cancelar") {
    return await mostrarCitasDelPaciente(msg.tenantId, phone.normalized, intencion as string);
  }

  // Si no, estamos en flujo de agendar: avanzar a tipo de pago
  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_TIPO_PAGO", {
    paciente_telefono: phone.normalized,
  });

  return [{
    kind: "buttons",
    text: "¿Cómo deseas pagar?",
    buttons: [
      { label: "💵 Efectivo", data: "tipopago:efectivo" },
      { label: "💳 Tarjeta", data: "tipopago:tarjeta" },
      { label: "🏦 Transferencia", data: "tipopago:transferencia" },
    ],
  }];
}


async function mostrarCitasDelPaciente(
  tenantId: string,
  telefono: string,
  intencion: string
): Promise<OutgoingMessage[]> {
  const citas = await consultarCitasActivasPorTelefono(tenantId, telefono);

  if (citas.length === 0) {
    return [{
      kind: "buttons",
      text: "No encontré citas activas con ese teléfono.",
      buttons: [{ label: "Volver al menú", data: "menu:inicio" }],
    }];
  }

  const lineas = citas.map(c =>
    `• *${c.codigo}* — ${formatFechaHoraDisplay(c.iniciaEn)}\n  ${c.servicioNombre}`
  ).join("\n\n");

  if (intencion === "consultar") {
    return [{
      kind: "buttons",
      text: `Tus citas activas:\n\n${lineas}`,
      buttons: [{ label: "Volver al menú", data: "menu:inicio" }],
    }];
  }

  // Intención = cancelar: mostrar botones por cita
  return [{
    kind: "buttons",
    text: `Tus citas activas:\n\n${lineas}\n\n¿Cuál deseas cancelar?`,
    buttons: citas.slice(0, 8).map(c => ({
      label: `Cancelar ${c.codigo}`,
      data: `cancelar_cita:${c.id}`,
    })),
  }];
}


async function handleIdleConLLM(
  msg: IncomingMessage,
  sesion: { id: string }
): Promise<OutgoingMessage[]> {
  // Construir contexto resumido del tenant
  const tenant = await tenantsRepo.findById(msg.tenantId);
  if (!tenant) return [{ kind: "text", text: "Tenant no disponible." }];

  const profesionales = await profesionalesRepo.listarActivos(msg.tenantId);
  const profesional = profesionales[0];
  const profDisplay = profesional
    ? `${profesional.prefijo} ${profesional.nombre} ${profesional.apellido}`
    : "Sin profesional configurado";

  const systemPrompt = buildSystemPrompt({
    nombreClinica: tenant.nombre_comercial,
    profesionalDisplay: profDisplay,
    serviciosTexto: "Consulta de Ginecología y Oncología, Citología, Colposcopia, Cono Asa, Biopsia de Mama, Cirugía Laparoscópica, Manejo de HPV.",
    sedesTexto: "3 sedes: Santo Domingo (Centro Médico María Dolores), San Pedro de Macorís (Unidad Oncológica del Este), Independencia (Centro Médico Doctor Paulino).",
    estadoSesion: "IDLE — paciente inicia conversación",
  });

  const history: LLMTurn[] = [];

  const llmRes = await callLLM({
    systemPrompt,
    history,
    userMessage: msg.text!,
    tools: ALL_TOOLS,
    maxTokens: 512,
  });

  // ¿Detectó intención agendar/cancelar/consultar?
  const intencionTool = llmRes.toolUses.find(t => t.name === "detectar_intencion");
  if (intencionTool) {
    const intencion = intencionTool.input["intencion"] as string;
    const confianza = (intencionTool.input["confianza"] as number) ?? 0;

    if (confianza >= 0.7) {
      if (intencion === "agendar" || intencion === "horarios") {
        return await iniciarFlujoAgendar(msg, sesion);
      }
      if (intencion === "consultar") {
        await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "consultar" });
        return [{ kind: "text", text: "Escríbeme tu número de teléfono para buscar tus citas." }];
      }
      if (intencion === "cancelar") {
        await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "cancelar" });
        return [{ kind: "text", text: "Escríbeme tu número de teléfono para buscar tus citas y cancelar la que necesites." }];
      }
    }
  }

  // Si el LLM respondió con texto, devolverlo + ofrecer menú
  const textoLLM = llmRes.text || "¿En qué puedo ayudarte?";
  await sessionManager.appendAssistant(sesion.id, textoLLM);

  return [
    { kind: "text", text: textoLLM },
    await menuPrincipal(msg.tenantId),
  ];
}


// ─── MENÚ PRINCIPAL ──────────────────────────────────────────────────

async function menuPrincipal(tenantId: string): Promise<OutgoingMessage> {
  const tenant = await tenantsRepo.findById(tenantId);
  const nombre = tenant?.nombre_comercial ?? "CitasMed";
  return {
    kind: "buttons",
    text: `👋 Bienvenido a *${nombre}*\n\n¿Qué deseas hacer?`,
    buttons: [
      { label: "📅 Agendar cita", data: "intent:agendar" },
      { label: "🔍 Consultar mis citas", data: "intent:consultar" },
      { label: "❌ Cancelar cita", data: "intent:cancelar" },
    ],
  };
}


// ─── HELPERS ─────────────────────────────────────────────────────────

function generarProximosDiasHabiles(cantidad: number): Array<{ iso: string; label: string }> {
  const dias = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const resultado: Array<{ iso: string; label: string }> = [];
  const hoy = new Date();
  hoy.setDate(hoy.getDate() + 1);   // empezar desde mañana

  while (resultado.length < cantidad) {
    const dow = hoy.getDay();
    if (dow !== 0 && dow !== 6) {   // saltar sáb y dom
      const iso = hoy.toISOString().slice(0, 10);
      const label = `${dias[dow]} ${hoy.getDate()} ${meses[hoy.getMonth()]}`;
      resultado.push({ iso, label });
    }
    hoy.setDate(hoy.getDate() + 1);
  }
  return resultado;
}

function formatFechaDisplay(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const dias = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  return `${dias[d.getDay()]} ${d.getDate()} de ${meses[d.getMonth()]}`;
}

function formatFechaHoraDisplay(iso: string): string {
  const d = new Date(iso);
  const fecha = formatFechaDisplay(d.toISOString().slice(0, 10));
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${fecha}, ${h12}:${m} ${ampm}`;
}
