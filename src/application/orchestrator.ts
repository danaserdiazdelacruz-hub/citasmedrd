// src/application/orchestrator.ts
// Cerebro del bot. Refactor con LLM como protagonista del texto libre.
//
// FILOSOFÍA:
//   - Botones para selecciones cerradas (sede, servicio, hora, confirmar)
//   - LLM responde a TODO texto libre, en cualquier estado
//   - El LLM solo SUGIERE; el orchestrator valida contra DB y aplica
//   - Plantillas son fallback cuando LLM falla, no default
//
// FLUJO DE TURNO:
//   1. Cargar/crear sesión
//   2. Si es comando (/start, /salir): manejarlo directamente
//   3. Si es click de botón: handler determinístico
//   4. Si es texto libre: pasar al LLM con prompt del estado actual
//   5. LLM puede llamar tools (sugerencias) — orchestrator valida y avanza
//   6. LLM puede responder con texto plano — orchestrator lo envía
//   7. Si LLM falla, fallback a plantilla genérica + menú

import { sessionManager } from "./session-manager.js";
import {
  callLLM,
  buildSystemPrompt,
  toolsParaEstado,
  LLMUnavailableError,
} from "./llm/index.js";
import type { LLMTurn, DatosTenantParaPrompt } from "./llm/index.js";
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
import type { SesionConversacion, EstadoSesion } from "../persistence/repositories/index.js";
import { validatePhoneDO, validateName } from "../domain/validators/index.js";
import { DomainError } from "../domain/errors.js";
import type { IncomingMessage, OutgoingMessage } from "../channels/core/types.js";
import * as M from "./messages.js";


// ─── Logger contextual ───────────────────────────────────────────────

type LogCtx = { tenantId: string; chatId: string; estado: string; updateId?: string };

function logInfo(ctx: LogCtx, evt: string, extra?: Record<string, unknown>): void {
  console.log(`[orch] tenant=${ctx.tenantId.slice(0, 8)} chat=${ctx.chatId} estado=${ctx.estado} ${evt}`,
    extra ? JSON.stringify(extra) : "");
}

function logWarn(ctx: LogCtx, evt: string, extra?: unknown): void {
  console.warn(`[orch] tenant=${ctx.tenantId.slice(0, 8)} chat=${ctx.chatId} estado=${ctx.estado} ${evt}`,
    extra ?? "");
}

function logError(ctx: LogCtx, evt: string, err: unknown): void {
  console.error(`[orch] tenant=${ctx.tenantId.slice(0, 8)} chat=${ctx.chatId} estado=${ctx.estado} ${evt}`, err);
}


// ─── Validación de transiciones FSM ──────────────────────────────────

const TRANSICIONES_VALIDAS: Record<EstadoSesion, EstadoSesion[]> = {
  IDLE: ["ELIGIENDO_SEDE", "PIDIENDO_TELEFONO"],
  ELIGIENDO_INTENCION: ["ELIGIENDO_SEDE", "PIDIENDO_TELEFONO", "IDLE"],
  ELIGIENDO_PROFESIONAL: ["ELIGIENDO_SEDE", "IDLE"],
  ELIGIENDO_SEDE: ["ELIGIENDO_SERVICIO", "IDLE"],
  ELIGIENDO_SERVICIO: ["ELIGIENDO_HORA", "IDLE"],
  ELIGIENDO_HORA: ["PIDIENDO_NOMBRE", "ELIGIENDO_HORA", "IDLE"],
  PIDIENDO_NOMBRE: ["PIDIENDO_TELEFONO", "PIDIENDO_NOMBRE", "IDLE"],
  PIDIENDO_TELEFONO: ["ELIGIENDO_TIPO_PAGO", "CONSULTANDO_CITA", "CANCELANDO_CITA", "PIDIENDO_TELEFONO", "IDLE"],
  ELIGIENDO_TIPO_PAGO: ["CONFIRMANDO", "IDLE"],
  ELIGIENDO_ASEGURADORA: ["CONFIRMANDO", "IDLE"],
  CONFIRMANDO: ["IDLE"],
  CONSULTANDO_CITA: ["IDLE"],
  CANCELANDO_CITA: ["IDLE"],
  REAGENDANDO_CITA: ["IDLE"],
};

function transicionValida(desde: EstadoSesion, hacia: EstadoSesion): boolean {
  if (desde === hacia) return true;
  return TRANSICIONES_VALIDAS[desde]?.includes(hacia) ?? false;
}


// ─── Validación defensiva de contexto ────────────────────────────────

interface ContextoCompletoParaConfirmacion {
  profesional_sede_id: string;
  servicio_id: string;
  servicio_nombre: string;
  servicio_precio: number;
  inicia_en: string;
  paciente_nombre: string;
  paciente_apellido: string;
  paciente_telefono: string;
  tipo_pago: string;
}

function validarContextoConfirmacion(ctx: Record<string, unknown>): ContextoCompletoParaConfirmacion | null {
  const requeridos = ["profesional_sede_id", "servicio_id", "servicio_nombre",
    "servicio_precio", "inicia_en", "paciente_nombre", "paciente_telefono", "tipo_pago"];
  for (const campo of requeridos) {
    if (ctx[campo] === undefined || ctx[campo] === null) return null;
  }
  return {
    profesional_sede_id: String(ctx["profesional_sede_id"]),
    servicio_id: String(ctx["servicio_id"]),
    servicio_nombre: String(ctx["servicio_nombre"]),
    servicio_precio: Number(ctx["servicio_precio"]),
    inicia_en: String(ctx["inicia_en"]),
    paciente_nombre: String(ctx["paciente_nombre"]),
    paciente_apellido: String(ctx["paciente_apellido"] ?? ""),
    paciente_telefono: String(ctx["paciente_telefono"]),
    tipo_pago: String(ctx["tipo_pago"]),
  };
}


// ─── Entry point ─────────────────────────────────────────────────────

export async function handleIncoming(msg: IncomingMessage): Promise<OutgoingMessage[]> {
  let sesion: SesionConversacion;
  try {
    sesion = await sessionManager.loadOrCreate({
      tenantId: msg.tenantId,
      canalConectadoId: msg.channelId,
      contactoExterno: msg.contactoExterno,
    });
  } catch (err) {
    console.error(`[orch] falló loadOrCreate de sesión:`, err);
    return [{ kind: "text", text: M.errorTecnico() }];
  }

  const ctx: LogCtx = {
    tenantId: msg.tenantId,
    chatId: msg.contactoExterno,
    estado: sesion.estado,
    updateId: msg.externalMessageId,
  };

  logInfo(ctx, `entrada type=${msg.type}`, {
    text: msg.text?.slice(0, 50),
    button: msg.buttonData,
    cmd: msg.command,
  });

  try {
    if (msg.type === "command") {
      return await handleCommand(msg, sesion, ctx);
    }
    if (msg.type === "button_click" && msg.buttonData) {
      return await handleButton(msg, sesion, ctx);
    }
    if (msg.type === "text" && msg.text) {
      return await handleText(msg, sesion, ctx);
    }
    return [{ kind: "text", text: M.noEntendi() }];
  } catch (err) {
    logError(ctx, "error no controlado en handleIncoming", err);
    try {
      await sessionManager.resetToIdle(sesion.id);
    } catch {
      // ignorar
    }
    return [{ kind: "text", text: M.errorTecnico() }];
  }
}


// ─── Comandos ────────────────────────────────────────────────────────

async function handleCommand(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  _ctx: LogCtx
): Promise<OutgoingMessage[]> {
  const cmd = msg.command;

  // /start SIEMPRE resetea (sin preguntar)
  if (cmd === "start" || cmd === "menu") {
    const fresh = await sessionManager.resetToIdle(sesion.id);
    return [await menuPrincipal(msg.tenantId, fresh)];
  }

  if (cmd === "cancelar" || cmd === "salir") {
    await sessionManager.resetToIdle(sesion.id);
    return [{ kind: "text", text: M.flujoCancelado() }];
  }

  return [{ kind: "text", text: M.noEntendi() }];
}


// ─── Botones (determinístico) ────────────────────────────────────────

async function handleButton(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  const data = msg.buttonData!;
  const colon = data.indexOf(":");
  const tipo = colon >= 0 ? data.slice(0, colon) : data;
  const valor = colon >= 0 ? data.slice(colon + 1) : "";

  try {
    switch (tipo) {
      case "intent":   return await handleIntentButton(msg, sesion, valor, ctx);
      case "sede":     return await handleSedeButton(sesion, valor, ctx);
      case "servicio": return await handleServicioButton(sesion, valor, ctx);
      case "fecha":    return await handleFechaButton(sesion, valor, ctx);
      case "slot":     return await handleSlotButton(sesion, valor, ctx);
      case "tipopago": return await handleTipoPagoButton(sesion, valor, ctx);
      case "confirmar":return await handleConfirmar(msg, sesion, valor, ctx);
      case "cancelar_cita": return await handleCancelarCitaButton(msg, sesion, valor, ctx);
      case "menu":
        const fresh = await sessionManager.resetToIdle(sesion.id);
        return [await menuPrincipal(msg.tenantId, fresh)];
      default:
        logWarn(ctx, `botón no reconocido: ${tipo}:${valor}`);
        return [{ kind: "text", text: M.noEntendi() }];
    }
  } catch (err) {
    logError(ctx, `error en handleButton tipo=${tipo}`, err);
    if (err instanceof DomainError) {
      return [{
        kind: "buttons",
        text: M.errorAgendar(err.message),
        buttons: M.botonVolverMenu,
      }];
    }
    return [{ kind: "text", text: M.errorTecnico() }];
  }
}


async function handleIntentButton(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  valor: string,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  if (valor === "agendar" || valor === "horarios") {
    return await iniciarFlujoAgendar(msg.tenantId, sesion, ctx);
  }

  const telefonoConocido = sesion.contexto["paciente_telefono_conocido"] as string | undefined;

  if (valor === "consultar") {
    if (telefonoConocido) {
      return await mostrarCitasDelPaciente(msg.tenantId, telefonoConocido, "consultar", sesion, ctx);
    }
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "consultar" });
    return [{ kind: "text", text: M.pidiendoTelefonoConsulta() }];
  }
  if (valor === "cancelar") {
    if (telefonoConocido) {
      return await mostrarCitasDelPaciente(msg.tenantId, telefonoConocido, "cancelar", sesion, ctx);
    }
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "cancelar" });
    return [{ kind: "text", text: M.pidiendoTelefonoCancelar() }];
  }
  return [{ kind: "text", text: M.noEntendi() }];
}


async function iniciarFlujoAgendar(
  tenantId: string,
  sesion: SesionConversacion,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  const profesionales = await profesionalesRepo.listarActivos(tenantId);
  if (profesionales.length === 0) {
    logWarn(ctx, "no hay profesionales activos");
    return [{ kind: "text", text: "No hay profesionales disponibles ahora mismo." }];
  }
  const profesional = profesionales[0];
  const sedes = await profesionalesRepo.listarSedesPorProfesional(tenantId, profesional.id);
  if (sedes.length === 0) {
    return [{ kind: "text", text: "No hay sedes disponibles." }];
  }

  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_SEDE", {
    profesional_id: profesional.id,
  });

  const profDisplay = `${profesional.prefijo} ${profesional.nombre} ${profesional.apellido}`;
  return [{
    kind: "buttons",
    text: M.eligiendoSede(profDisplay),
    buttons: sedes.map(s => ({ label: s.sede.nombre, data: `sede:${s.profesionalSede.id}` })),
  }];
}


async function handleSedeButton(
  sesion: SesionConversacion,
  psId: string,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  if (!transicionValida(sesion.estado, "ELIGIENDO_SERVICIO")) {
    logWarn(ctx, `transición inválida ${sesion.estado} → ELIGIENDO_SERVICIO`);
    const fresh = await sessionManager.resetToIdle(sesion.id);
    return [await menuPrincipal(sesion.tenant_id, fresh)];
  }

  const ps = await profesionalesRepo.findProfesionalSedeById(psId);
  if (!ps) {
    logWarn(ctx, `profesional_sede no encontrada: ${psId}`);
    return [{ kind: "text", text: "Esa sede no está disponible. Intenta de nuevo." }];
  }

  const servicios = await profesionalesRepo.listarServiciosPublicos(psId);
  if (servicios.length === 0) {
    return [{ kind: "text", text: "Esa sede no tiene servicios disponibles ahora." }];
  }

  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_SERVICIO", {
    profesional_sede_id: psId,
    sede_id: ps.sede_id,
  });

  return [{
    kind: "list",
    text: M.eligiendoServicio(),
    options: servicios.slice(0, 10).map(s => ({
      label: `${s.nombre} — RD$${s.precio.toLocaleString()}`,
      description: `${s.duracion_min} min`,
      data: `servicio:${s.id}`,
    })),
  }];
}


async function handleServicioButton(
  sesion: SesionConversacion,
  servicioId: string,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  if (!transicionValida(sesion.estado, "ELIGIENDO_HORA")) {
    logWarn(ctx, `transición inválida ${sesion.estado} → ELIGIENDO_HORA`);
    const fresh = await sessionManager.resetToIdle(sesion.id);
    return [await menuPrincipal(sesion.tenant_id, fresh)];
  }

  const servicio = await profesionalesRepo.findServicioById(servicioId);
  if (!servicio) {
    logWarn(ctx, `servicio no encontrado: ${servicioId}`);
    return [{ kind: "text", text: "Ese servicio no está disponible." }];
  }

  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_HORA", {
    servicio_id: servicioId,
    servicio_nombre: servicio.nombre,
    servicio_precio: servicio.precio,
    servicio_duracion: servicio.duracion_min,
  });

  return [{
    kind: "buttons",
    text: M.eligiendoDia(servicio.nombre, servicio.precio, servicio.duracion_min),
    buttons: generarProximosDiasHabiles(5).map(d => ({
      label: d.label,
      data: `fecha:${d.iso}`,
    })),
  }];
}


async function handleFechaButton(
  sesion: SesionConversacion,
  fecha: string,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  const psId = sesion.contexto["profesional_sede_id"] as string | undefined;
  if (!psId) {
    logWarn(ctx, "fecha sin profesional_sede_id en contexto, reseteando");
    const fresh = await sessionManager.resetToIdle(sesion.id);
    return [await menuPrincipal(sesion.tenant_id, fresh)];
  }

  const slots = await listarHorariosLibres({ profesionalSedeId: psId, fecha });

  if (slots.length === 0) {
    return [{
      kind: "buttons",
      text: M.diaSinHorarios(formatFechaDisplay(fecha)),
      buttons: generarProximosDiasHabiles(5).map(d => ({ label: d.label, data: `fecha:${d.iso}` })),
    }];
  }

  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_HORA", {
    fecha_seleccionada: fecha,
  });

  return [{
    kind: "buttons",
    text: M.eligiendoHora(formatFechaDisplay(fecha)),
    buttons: slots.slice(0, 8).map(s => ({
      label: s.horaDisplay,
      data: `slot:${s.iniciaEn}`,
    })),
  }];
}


async function handleSlotButton(
  sesion: SesionConversacion,
  iniciaEn: string,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  if (!transicionValida(sesion.estado, "PIDIENDO_NOMBRE")) {
    logWarn(ctx, `transición inválida ${sesion.estado} → PIDIENDO_NOMBRE`);
    const fresh = await sessionManager.resetToIdle(sesion.id);
    return [await menuPrincipal(sesion.tenant_id, fresh)];
  }

  // Si tenemos nombre conocido, saltamos directo a teléfono
  const nombreConocido = sesion.contexto["paciente_nombre_conocido"] as string | undefined;
  if (nombreConocido) {
    const apellidoConocido = sesion.contexto["paciente_apellido_conocido"] as string | undefined ?? "";
    const telConocido = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
    if (telConocido) {
      // Tenemos todo, saltar a tipo de pago
      await sessionManager.transitionTo(sesion.id, "ELIGIENDO_TIPO_PAGO", {
        inicia_en: iniciaEn,
        paciente_nombre: nombreConocido,
        paciente_apellido: apellidoConocido,
        paciente_telefono: telConocido,
      });
      return [{
        kind: "buttons",
        text: `Genial ${nombreConocido} 🙌\n\n${M.eligiendoTipoPago()}`,
        buttons: M.opcionesTipoPago,
      }];
    }
    // Solo tenemos nombre, saltar a teléfono
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", {
      inicia_en: iniciaEn,
      paciente_nombre: nombreConocido,
      paciente_apellido: apellidoConocido,
    });
    return [{
      kind: "text",
      text: `Hola de nuevo ${nombreConocido} 🙌 ${M.pidiendoTelefonoAgenda(nombreConocido)}`,
    }];
  }

  await sessionManager.transitionTo(sesion.id, "PIDIENDO_NOMBRE", {
    inicia_en: iniciaEn,
  });

  return [{ kind: "text", text: M.pidiendoNombre() }];
}


async function handleTipoPagoButton(
  sesion: SesionConversacion,
  tipo: string,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  if (!["efectivo", "tarjeta", "transferencia"].includes(tipo)) {
    return [{ kind: "text", text: "Esa forma de pago no está disponible aún." }];
  }

  if (!transicionValida(sesion.estado, "CONFIRMANDO")) {
    logWarn(ctx, `transición inválida ${sesion.estado} → CONFIRMANDO`);
    const fresh = await sessionManager.resetToIdle(sesion.id);
    return [await menuPrincipal(sesion.tenant_id, fresh)];
  }

  // FIX BUG STALE CONTEXT: usar sesión actualizada que retorna transitionTo
  const sesionActualizada = await sessionManager.transitionTo(
    sesion.id,
    "CONFIRMANDO",
    { tipo_pago: tipo }
  );

  const ctxValidado = validarContextoConfirmacion(sesionActualizada.contexto);
  if (!ctxValidado) {
    logError(ctx, "contexto incompleto para confirmación", sesionActualizada.contexto);
    await sessionManager.resetToIdle(sesion.id);
    return [{
      kind: "buttons",
      text: "Faltan datos para confirmar la cita. Empecemos de nuevo.",
      buttons: M.botonVolverMenu,
    }];
  }

  // Si es transferencia, agregar datos bancarios al mensaje
  const datosBancarios = tipo === "transferencia"
    ? "\n\n💳 *Datos bancarios:*\n_Disponibles al confirmar la cita._"
    : "";

  const fechaHora = formatFechaHoraDisplay(ctxValidado.inicia_en);
  return [{
    kind: "buttons",
    text: M.resumenConfirmacion(
      ctxValidado.paciente_nombre,
      ctxValidado.paciente_apellido,
      ctxValidado.paciente_telefono,
      ctxValidado.servicio_nombre,
      fechaHora,
      ctxValidado.servicio_precio,
      ctxValidado.tipo_pago,
    ) + datosBancarios,
    buttons: M.opcionesConfirmacion,
  }];
}


async function handleConfirmar(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  valor: string,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  if (valor !== "si") {
    const fresh = await sessionManager.resetToIdle(sesion.id);
    return [
      { kind: "text", text: M.flujoCancelado() },
      await menuPrincipal(msg.tenantId, fresh),
    ];
  }

  const fresh = await sessionManager.loadFresh(sesion.id);
  if (!fresh) {
    logError(ctx, "sesión desapareció antes de confirmar", null);
    return [{ kind: "text", text: M.errorTecnico() }];
  }

  const ctxValidado = validarContextoConfirmacion(fresh.contexto);
  if (!ctxValidado) {
    logError(ctx, "contexto incompleto en confirmar", fresh.contexto);
    await sessionManager.resetToIdle(sesion.id);
    return [{ kind: "text", text: "Faltan datos. Empecemos de nuevo. Usa /start." }];
  }

  try {
    const result = await agendarCita({
      tenantId: msg.tenantId,
      profesionalSedeId: ctxValidado.profesional_sede_id,
      servicioId: ctxValidado.servicio_id,
      iniciaEn: ctxValidado.inicia_en,
      canalOrigen: "telegram",
      pacienteTelefono: ctxValidado.paciente_telefono,
      pacienteNombre: ctxValidado.paciente_nombre,
      pacienteApellido: ctxValidado.paciente_apellido,
      tipoPago: ctxValidado.tipo_pago as "efectivo" | "tarjeta" | "transferencia",
    });

    logInfo(ctx, `cita creada: ${result.codigo}`);
    // Reset preservando memoria del paciente
    await sessionManager.resetToIdle(sesion.id, true);
    await sessionManager.transitionTo(sesion.id, "IDLE", {
      paciente_telefono_conocido: ctxValidado.paciente_telefono,
      paciente_nombre_conocido: ctxValidado.paciente_nombre,
      paciente_apellido_conocido: ctxValidado.paciente_apellido,
    });
    return [{ kind: "text", text: M.citaConfirmada(result.codigo) }];

  } catch (err) {
    if (err instanceof DomainError) {
      logWarn(ctx, `dominio rechazó agendar: ${err.code}`, { msg: err.message });
      await sessionManager.resetToIdle(sesion.id);
      return [{
        kind: "buttons",
        text: M.errorAgendar(err.message),
        buttons: M.botonVolverMenu,
      }];
    }
    logError(ctx, "error inesperado en confirmar", err);
    await sessionManager.resetToIdle(sesion.id);
    return [{ kind: "text", text: M.errorTecnico() }];
  }
}


async function handleCancelarCitaButton(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  citaId: string,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  try {
    await cancelarCita({
      tenantId: msg.tenantId,
      citaId,
      motivo: "cancelada por paciente vía bot",
    });
    logInfo(ctx, `cita cancelada: ${citaId}`);
    await sessionManager.resetToIdle(sesion.id);
    return [{ kind: "text", text: M.citaCancelada() }];
  } catch (err) {
    if (err instanceof DomainError) {
      return [{ kind: "text", text: M.errorAgendar(err.message) }];
    }
    logError(ctx, "error cancelando cita", err);
    return [{ kind: "text", text: M.errorTecnico() }];
  }
}


// ─── TEXTO LIBRE — el LLM es protagonista ────────────────────────────

async function handleText(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  await sessionManager.appendUser(sesion.id, msg.text!);

  // Validación específica de teléfono (regex, sin LLM) — más rápido
  if (sesion.estado === "PIDIENDO_TELEFONO") {
    const phone = validatePhoneDO(msg.text!);
    if (phone.valid && phone.normalized) {
      return await procesarTelefonoValidado(msg.tenantId, sesion, phone.normalized, ctx);
    }
    // Si NO es teléfono válido, dejamos que el LLM responda con contexto
  }

  // Validación específica de nombre (regex, sin LLM) — más rápido
  if (sesion.estado === "PIDIENDO_NOMBRE") {
    const val = validateName(msg.text!);
    if (val.valid && val.apellido) {  // requerir apellido
      return await procesarNombreValidado(sesion, val.nombre, val.apellido);
    }
    // Si solo nombre sin apellido, o nombre inválido, LLM responde
  }

  // Cualquier otro caso: pasar al LLM con contexto del estado
  return await responderConLLM(msg, sesion, ctx);
}


async function procesarTelefonoValidado(
  tenantId: string,
  sesion: SesionConversacion,
  telefonoE164: string,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  const intencion = sesion.contexto["intencion"] as string | undefined;

  if (intencion === "consultar" || intencion === "cancelar") {
    await sessionManager.transitionTo(sesion.id, sesion.estado, {
      paciente_telefono_conocido: telefonoE164,
    });
    return await mostrarCitasDelPaciente(tenantId, telefonoE164, intencion, sesion, ctx);
  }

  // Flujo agendar
  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_TIPO_PAGO", {
    paciente_telefono: telefonoE164,
    paciente_telefono_conocido: telefonoE164,
  });

  return [{
    kind: "buttons",
    text: M.eligiendoTipoPago(),
    buttons: M.opcionesTipoPago,
  }];
}


async function procesarNombreValidado(
  sesion: SesionConversacion,
  nombre: string,
  apellido: string
): Promise<OutgoingMessage[]> {
  await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", {
    paciente_nombre: nombre,
    paciente_apellido: apellido,
  });
  return [{ kind: "text", text: M.pidiendoTelefonoAgenda(nombre) }];
}


async function mostrarCitasDelPaciente(
  tenantId: string,
  telefono: string,
  intencion: string,
  sesion: SesionConversacion,
  _ctx: LogCtx
): Promise<OutgoingMessage[]> {
  const citas = await consultarCitasActivasPorTelefono(tenantId, telefono);

  if (citas.length === 0) {
    await sessionManager.resetToIdle(sesion.id);
    return [{
      kind: "buttons",
      text: M.sinCitasActivas(),
      buttons: [
        { label: "📅 Agendar ahora", data: "intent:agendar" },
        { label: "🏠 Volver al menú", data: "menu:inicio" },
      ],
    }];
  }

  const resumen = citas.map(c => ({
    codigo: c.codigo,
    fechaHora: formatFechaHoraDisplay(c.iniciaEn),
    servicio: c.servicioNombre,
  }));

  if (intencion === "consultar") {
    await sessionManager.resetToIdle(sesion.id);
    return [{
      kind: "buttons",
      text: M.citasActivasResumen(resumen),
      buttons: M.botonVolverMenu,
    }];
  }

  await sessionManager.transitionTo(sesion.id, "CANCELANDO_CITA", {});
  return [{
    kind: "buttons",
    text: M.citasActivasResumen(resumen) + M.eligeCitaCancelar(),
    buttons: citas.slice(0, 8).map(c => ({
      label: `❌ Cancelar ${c.codigo}`,
      data: `cancelar_cita:${c.id}`,
    })),
  }];
}


// ─── LLM como protagonista del texto libre ───────────────────────────

async function responderConLLM(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  let datos: DatosTenantParaPrompt;
  try {
    datos = await construirDatosTenant(msg.tenantId, sesion);
  } catch (err) {
    logError(ctx, "no pude construir datos tenant", err);
    return await fallbackSinLLM(msg.tenantId, sesion);
  }

  const systemPrompt = buildSystemPrompt(
    { estado: sesion.estado, contexto: sesion.contexto },
    datos
  );

  // Construir historial real (últimos 10 turnos)
  const historial = Array.isArray(sesion.historial) ? sesion.historial : [];
  const history: LLMTurn[] = historial.slice(-10).map(h => ({
    role: (h.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
    content: String(h.content),
  }));

  const tools = toolsParaEstado(sesion.estado);

  let llmRes;
  try {
    llmRes = await callLLM({
      systemPrompt,
      history,
      userMessage: msg.text!,
      tools,
      maxTokens: 512,
    });
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      logWarn(ctx, "LLM no disponible, fallback", { msg: err.message });
    } else {
      logError(ctx, "error LLM inesperado", err);
    }
    return await fallbackSinLLM(msg.tenantId, sesion);
  }

  // Procesar tools que llamó el LLM
  if (llmRes.toolUses.length > 0) {
    return await procesarToolUses(msg.tenantId, sesion, llmRes.toolUses, ctx);
  }

  // Sin tools, solo texto del LLM
  if (llmRes.text) {
    await sessionManager.appendAssistant(sesion.id, llmRes.text);
    return [{ kind: "text", text: llmRes.text }];
  }

  // Sin tools ni texto: fallback
  return await fallbackSinLLM(msg.tenantId, sesion);
}


async function procesarToolUses(
  tenantId: string,
  sesion: SesionConversacion,
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  // Procesamos en orden. La primera tool válida cambia el estado y devuelve mensaje.
  for (const tu of toolUses) {
    const result = await procesarUnTool(tenantId, sesion, tu, ctx);
    if (result) return result;
  }
  // Ninguna tool produjo resultado válido
  return await fallbackSinLLM(tenantId, sesion);
}


async function procesarUnTool(
  tenantId: string,
  sesion: SesionConversacion,
  tu: { name: string; input: Record<string, unknown> },
  ctx: LogCtx
): Promise<OutgoingMessage[] | null> {
  logInfo(ctx, `LLM llamó tool: ${tu.name}`, tu.input);

  switch (tu.name) {
    case "detectar_intencion": {
      const intencion = String(tu.input["intencion"] ?? "");
      const confianza = Number(tu.input["confianza"] ?? 0);
      if (confianza < 0.7) return null;
      if (intencion === "agendar" || intencion === "horarios") {
        return await iniciarFlujoAgendar(tenantId, sesion, ctx);
      }
      if (intencion === "consultar" || intencion === "cancelar") {
        const tel = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
        if (tel) return await mostrarCitasDelPaciente(tenantId, tel, intencion, sesion, ctx);
        await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion });
        return [{
          kind: "text",
          text: intencion === "consultar" ? M.pidiendoTelefonoConsulta() : M.pidiendoTelefonoCancelar(),
        }];
      }
      return null;
    }

    case "reset_flujo": {
      logInfo(ctx, "LLM solicitó reset_flujo");
      const fresh = await sessionManager.resetToIdle(sesion.id);
      return [
        { kind: "text", text: M.flujoCancelado() },
        await menuPrincipal(tenantId, fresh),
      ];
    }

    case "extraer_telefono": {
      const raw = String(tu.input["telefono_raw"] ?? "");
      const phone = validatePhoneDO(raw);
      if (!phone.valid || !phone.normalized) return null;
      return await procesarTelefonoValidado(tenantId, sesion, phone.normalized, ctx);
    }

    case "extraer_nombre": {
      const nombre = String(tu.input["nombre"] ?? "").trim();
      const apellido = String(tu.input["apellido"] ?? "").trim();
      if (!nombre) return null;
      if (!apellido) {
        // LLM detectó solo nombre — pedirle apellido
        return [{ kind: "text", text: `Gracias ${nombre} 🙌 ¿Y tu apellido?` }];
      }
      return await procesarNombreValidado(sesion, nombre, apellido);
    }

    case "sugerir_sede": {
      const sedeId = String(tu.input["sede_id"] ?? "");
      // sede_id en realidad es profesional_sede_id (ver prompt)
      const ps = await profesionalesRepo.findProfesionalSedeById(sedeId);
      if (!ps) {
        logWarn(ctx, `LLM sugirió sede inválida: ${sedeId}`);
        return null;
      }
      return await handleSedeButton(sesion, sedeId, ctx);
    }

    case "sugerir_servicio": {
      const servicioId = String(tu.input["servicio_id"] ?? "");
      const servicio = await profesionalesRepo.findServicioById(servicioId);
      if (!servicio) {
        logWarn(ctx, `LLM sugirió servicio inválido: ${servicioId}`);
        return null;
      }
      return await handleServicioButton(sesion, servicioId, ctx);
    }

    case "sugerir_fecha": {
      const fecha = String(tu.input["fecha_iso"] ?? "");
      // Validar que sea fecha válida y futura
      const d = new Date(fecha + "T00:00:00");
      if (isNaN(d.getTime())) {
        logWarn(ctx, `LLM sugirió fecha inválida: ${fecha}`);
        return null;
      }
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
      if (d < hoy) {
        logWarn(ctx, `LLM sugirió fecha en pasado: ${fecha}`);
        return null;
      }
      const dow = d.getDay();
      if (dow === 0 || dow === 6) {
        return [{ kind: "text", text: "Esa fecha es fin de semana 😔 No atendemos esos días. Elige otra." }];
      }
      return await handleFechaButton(sesion, fecha, ctx);
    }

    default:
      logWarn(ctx, `tool no implementada: ${tu.name}`);
      return null;
  }
}


async function fallbackSinLLM(
  tenantId: string,
  sesion: SesionConversacion
): Promise<OutgoingMessage[]> {
  // Si está en flujo, mostrar el menú actual del estado
  if (sesion.estado === "IDLE") {
    return [await menuPrincipal(tenantId, sesion)];
  }
  // En otros estados, recordar al usuario qué se espera
  return [
    { kind: "text", text: M.noEntendi() },
    await menuPrincipal(tenantId, sesion),
  ];
}


// ─── Construir datos tenant para prompts ─────────────────────────────

async function construirDatosTenant(
  tenantId: string,
  sesion: SesionConversacion
): Promise<DatosTenantParaPrompt> {
  const tenant = await tenantsRepo.findById(tenantId);
  const profesionales = await profesionalesRepo.listarActivos(tenantId);
  const profesional = profesionales[0];
  const profDisplay = profesional
    ? `${profesional.prefijo} ${profesional.nombre} ${profesional.apellido}`
    : "Sin profesional configurado";

  // Sedes para el prompt de ELIGIENDO_SEDE
  let sedesPrompt: Array<{ id: string; nombre: string; ciudad: string }> = [];
  if (profesional) {
    const sedesData = await profesionalesRepo.listarSedesPorProfesional(tenantId, profesional.id);
    sedesPrompt = sedesData.map(s => ({
      id: s.profesionalSede.id,
      nombre: s.sede.nombre,
      ciudad: s.sede.ciudad ?? "",
    }));
  }

  // Servicios para el prompt de ELIGIENDO_SERVICIO
  let serviciosPrompt: Array<{ id: string; nombre: string; precio: number; duracion_min: number }> = [];
  const psId = sesion.contexto["profesional_sede_id"] as string | undefined;
  if (psId) {
    const servs = await profesionalesRepo.listarServiciosPublicos(psId);
    serviciosPrompt = servs.map(s => ({
      id: s.id,
      nombre: s.nombre,
      precio: Number(s.precio),
      duracion_min: s.duracion_min,
    }));
  } else if (sedesPrompt.length > 0) {
    // En IDLE no tenemos psId, pero podemos mostrar servicios de la primera sede
    const servs = await profesionalesRepo.listarServiciosPublicos(sedesPrompt[0].id);
    serviciosPrompt = servs.map(s => ({
      id: s.id,
      nombre: s.nombre,
      precio: Number(s.precio),
      duracion_min: s.duracion_min,
    }));
  }

  return {
    nombreClinica: tenant?.nombre_comercial ?? "la clínica",
    profesionalDisplay: profDisplay,
    sedes: sedesPrompt,
    servicios: serviciosPrompt,
    telefonosConsultorio: [],
  };
}


// ─── Menú principal ──────────────────────────────────────────────────

async function menuPrincipal(
  tenantId: string,
  _sesion: SesionConversacion
): Promise<OutgoingMessage> {
  const tenant = await tenantsRepo.findById(tenantId);
  const nombre = tenant?.nombre_comercial ?? "CitasMed";
  return {
    kind: "buttons",
    text: M.saludoBienvenida(nombre),
    buttons: M.opcionesMenu,
  };
}


// ─── Helpers de fecha ────────────────────────────────────────────────

function generarProximosDiasHabiles(cantidad: number): Array<{ iso: string; label: string }> {
  const dias = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const resultado: Array<{ iso: string; label: string }> = [];
  const hoy = new Date();
  hoy.setDate(hoy.getDate() + 1);

  while (resultado.length < cantidad) {
    const dow = hoy.getDay();
    if (dow !== 0 && dow !== 6) {
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
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
    "septiembre", "octubre", "noviembre", "diciembre"];
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
