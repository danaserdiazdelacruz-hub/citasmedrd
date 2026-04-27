// src/application/orchestrator.ts
// El cerebro del bot. Refactor con seguridad por capas.
//
// CAMBIOS vs versión anterior:
//   1. transitionTo retorna sesión actualizada → adiós bug de stale context
//   2. Validación de transiciones FSM (matriz de estados permitidos)
//   3. Try/catch granular por handler con logs contextuales
//   4. Recuperación automática de estado roto
//   5. Plantillas cálidas en messages.ts (no strings duros)
//   6. LLM con fallback a plantillas si falla
//   7. Detección de "cancelación" en cualquier estado
//   8. Validación defensiva de cada lectura de contexto

import { sessionManager } from "./session-manager.js";
import { callLLM, buildSystemPrompt, ALL_TOOLS, LLMUnavailableError } from "./llm/index.js";
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


// ─── Logger contextual simple ────────────────────────────────────────

type LogCtx = { tenantId: string; chatId: string; estado: string; updateId?: string };

function logInfo(ctx: LogCtx, evt: string, extra?: Record<string, unknown>): void {
  console.log(`[orch] tenant=${ctx.tenantId.slice(0, 8)} chat=${ctx.chatId} estado=${ctx.estado} ${evt}`,
    extra ? JSON.stringify(extra) : "");
}

function logWarn(ctx: LogCtx, evt: string, extra?: Record<string, unknown>): void {
  console.warn(`[orch] tenant=${ctx.tenantId.slice(0, 8)} chat=${ctx.chatId} estado=${ctx.estado} ${evt}`,
    extra ?? "");
}

function logError(ctx: LogCtx, evt: string, err: unknown): void {
  console.error(`[orch] tenant=${ctx.tenantId.slice(0, 8)} chat=${ctx.chatId} estado=${ctx.estado} ${evt}`, err);
}


// ─── Detección universal de "cancelar" ───────────────────────────────

const PALABRAS_CANCELAR = [
  "cancela", "cancelar", "cancelado", "cancelalo", "cancélalo",
  "olvida", "olvídalo", "olvidalo", "olvida eso", "ya no quiero",
  "no quiero", "déjalo", "dejalo", "salir", "salida", "atrás",
  "atras", "regresar", "volver al menú", "volver al menu",
  "menu", "menú", "inicio", "stop", "detente", "para",
];

function quiereCancelar(texto: string): boolean {
  const limpio = texto.toLowerCase().trim();
  if (limpio.length === 0) return false;
  return PALABRAS_CANCELAR.some(p => limpio === p || limpio.includes(p));
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


// ─── Entry point del orchestrator ────────────────────────────────────

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
    // 1. Comandos
    if (msg.type === "command") {
      return await handleCommand(msg, sesion, ctx);
    }

    // 2. Detección universal de cancelación (texto libre)
    if (msg.type === "text" && msg.text && quiereCancelar(msg.text)
        && sesion.estado !== "IDLE") {
      logInfo(ctx, "usuario quiere cancelar flujo");
      const fresh = await sessionManager.resetToIdle(sesion.id);
      return [
        { kind: "text", text: M.flujoCancelado() },
        await menuPrincipal(msg.tenantId, fresh),
      ];
    }

    // 3. Click de botón (determinístico)
    if (msg.type === "button_click" && msg.buttonData) {
      return await handleButton(msg, sesion, ctx);
    }

    // 4. Texto libre
    if (msg.type === "text" && msg.text) {
      return await handleText(msg, sesion, ctx);
    }

    return [{ kind: "text", text: M.noEntendi() }];
  } catch (err) {
    logError(ctx, "error no controlado en handleIncoming", err);
    // Reset suave y devolver menú
    try {
      await sessionManager.resetToIdle(sesion.id);
    } catch {
      // Ignorar — ya estamos en path de error
    }
    return [{ kind: "text", text: M.errorTecnico() }];
  }
}


// ─── Comandos ────────────────────────────────────────────────────────

async function handleCommand(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  const cmd = msg.command;

  if (cmd === "start" || cmd === "menu") {
    // Si está a mitad de flujo, preguntar antes de resetear
    if (sesion.estado !== "IDLE") {
      logInfo(ctx, "/start a mitad de flujo, pidiendo confirmación");
      return [{
        kind: "buttons",
        text: M.reseteoConfirmar(),
        buttons: M.opcionesReseteo,
      }];
    }
    const fresh = await sessionManager.resetToIdle(sesion.id);
    return [await menuPrincipal(msg.tenantId, fresh)];
  }

  if (cmd === "cancelar" || cmd === "salir") {
    await sessionManager.resetToIdle(sesion.id);
    return [{ kind: "text", text: M.flujoCancelado() }];
  }

  // Comando desconocido
  return [{ kind: "text", text: M.noEntendi() }];
}


// ─── Botones ─────────────────────────────────────────────────────────

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
      case "reset":
        if (valor === "si") {
          const f = await sessionManager.resetToIdle(sesion.id);
          return [
            { kind: "text", text: M.flujoCancelado() },
            await menuPrincipal(msg.tenantId, f),
          ];
        }
        return [{ kind: "text", text: "👍 Continuamos donde estábamos. Sigue el flujo." }];
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
  if (valor === "consultar") {
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "consultar" });
    return [{ kind: "text", text: M.pidiendoTelefonoConsulta() }];
  }
  if (valor === "cancelar") {
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "cancelar" });
    return [{ kind: "text", text: M.pidiendoTelefonoCancelar() }];
  }
  logWarn(ctx, `intent button valor desconocido: ${valor}`);
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
    logWarn(ctx, "profesional sin sedes activas");
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
    logWarn(ctx, `tipo de pago inválido: ${tipo}`);
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

  // Validar contexto antes de renderizar
  const ctxValidado = validarContextoConfirmacion(sesionActualizada.contexto);
  if (!ctxValidado) {
    logError(ctx, "contexto incompleto para confirmación", sesionActualizada.contexto);
    await sessionManager.resetToIdle(sesion.id);
    return [{
      kind: "buttons",
      text: "Faltan datos para confirmar la cita. Vamos a empezar de nuevo.",
      buttons: M.botonVolverMenu,
    }];
  }

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
    ),
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

  // Recargar sesión fresca por si hubo races
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
    await sessionManager.resetToIdle(sesion.id);
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


// ─── Texto libre ─────────────────────────────────────────────────────

async function handleText(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  await sessionManager.appendUser(sesion.id, msg.text!);

  // Estados que esperan input específico
  if (sesion.estado === "PIDIENDO_NOMBRE") {
    return await handlePidiendoNombre(msg.text!, sesion, ctx);
  }
  if (sesion.estado === "PIDIENDO_TELEFONO") {
    return await handlePidiendoTelefono(msg, sesion, ctx);
  }

  // Otros estados con texto libre: si es IDLE, usar LLM; si no, mostrar menú
  if (sesion.estado === "IDLE") {
    return await handleIdleConLLM(msg, sesion, ctx);
  }

  logWarn(ctx, `texto libre en estado ${sesion.estado} sin handler específico`);
  return [
    { kind: "text", text: M.noEntendi() },
    await menuPrincipal(msg.tenantId, sesion),
  ];
}


async function handlePidiendoNombre(
  texto: string,
  sesion: SesionConversacion,
  _ctx: LogCtx
): Promise<OutgoingMessage[]> {
  const val = validateName(texto);
  if (!val.valid) {
    return [{ kind: "text", text: M.nombreInvalido(val.reason ?? "nombre inválido") }];
  }

  const fresh = await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", {
    paciente_nombre: val.nombre,
    paciente_apellido: val.apellido,
  });
  void fresh; // sesión actualizada disponible si hace falta

  return [{ kind: "text", text: M.pidiendoTelefonoAgenda(val.nombre) }];
}


async function handlePidiendoTelefono(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  const phone = validatePhoneDO(msg.text!);
  if (!phone.valid || !phone.normalized) {
    return [{ kind: "text", text: M.telefonoInvalido(phone.reason ?? "teléfono inválido") }];
  }

  const intencion = sesion.contexto["intencion"];
  if (intencion === "consultar" || intencion === "cancelar") {
    return await mostrarCitasDelPaciente(msg.tenantId, phone.normalized, intencion as string, sesion, ctx);
  }

  // Flujo agendar
  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_TIPO_PAGO", {
    paciente_telefono: phone.normalized,
  });

  return [{
    kind: "buttons",
    text: M.eligiendoTipoPago(),
    buttons: M.opcionesTipoPago,
  }];
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

  // intencion === "cancelar"
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


async function handleIdleConLLM(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  // Si el LLM no funciona o el circuit breaker está abierto, fallback a menú
  let textoLLM = "";
  let intencionDetectada: string | null = null;

  try {
    const tenant = await tenantsRepo.findById(msg.tenantId);
    const profesionales = await profesionalesRepo.listarActivos(msg.tenantId);
    const profesional = profesionales[0];
    const profDisplay = profesional
      ? `${profesional.prefijo} ${profesional.nombre} ${profesional.apellido}`
      : "Sin profesional configurado";

    const systemPrompt = buildSystemPrompt({
      nombreClinica: tenant?.nombre_comercial ?? "la clínica",
      profesionalDisplay: profDisplay,
      serviciosTexto: "Consulta de Ginecología y Oncología, Citología, Colposcopia, Cono Asa, Biopsia de Mama, Cirugía Laparoscópica, Manejo de HPV.",
      sedesTexto: "3 sedes: Santo Domingo (Centro Médico María Dolores), San Pedro de Macorís (Unidad Oncológica del Este), Independencia (Centro Médico Doctor Paulino).",
      estadoSesion: "IDLE",
    });

    const llmRes = await callLLM({
      systemPrompt,
      history: [],
      userMessage: msg.text!,
      tools: ALL_TOOLS,
      maxTokens: 512,
    });

    textoLLM = llmRes.text;

    const intencionTool = llmRes.toolUses.find(t => t.name === "detectar_intencion");
    if (intencionTool) {
      const intencion = intencionTool.input["intencion"] as string;
      const confianza = (intencionTool.input["confianza"] as number) ?? 0;
      if (confianza >= 0.7) intencionDetectada = intencion;
    }

  } catch (err: unknown) {
    if (err instanceof LLMUnavailableError) {
      logWarn(ctx, "LLM no disponible, fallback a menú", { msg: err.message });
    } else {
      logError(ctx, "error inesperado en LLM, fallback a menú", err);
    }
    // Fallback: solo mostrar menú
    return [await menuPrincipal(msg.tenantId, sesion)];
  }

  // Manejar intención detectada
  if (intencionDetectada === "agendar" || intencionDetectada === "horarios") {
    return await iniciarFlujoAgendar(msg.tenantId, sesion, ctx);
  }
  if (intencionDetectada === "consultar") {
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "consultar" });
    return [{ kind: "text", text: M.pidiendoTelefonoConsulta() }];
  }
  if (intencionDetectada === "cancelar") {
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "cancelar" });
    return [{ kind: "text", text: M.pidiendoTelefonoCancelar() }];
  }

  // Sin intención clara: responder con texto del LLM (si lo hay) + menú
  if (textoLLM) {
    await sessionManager.appendAssistant(sesion.id, textoLLM);
    return [
      { kind: "text", text: textoLLM },
      await menuPrincipal(msg.tenantId, sesion),
    ];
  }

  return [await menuPrincipal(msg.tenantId, sesion)];
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
