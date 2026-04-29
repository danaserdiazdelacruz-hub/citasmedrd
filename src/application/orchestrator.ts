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
import type { SesionConversacion, EstadoSesion, Tenant } from "../persistence/repositories/index.js";
import { validatePhoneDO, validateName } from "../domain/validators/index.js";
import { DomainError } from "../domain/errors.js";
import {
  proximosDiasHabiles,
  formatFechaLarga,
  formatFechaHora,
  formatHoraCorta,
} from "../domain/datetime.js";
import { extraerHistorialParaLLM } from "../domain/historial.js";
import { resumirHorariosAtencion } from "../domain/horarios.js";
import { textoComoComando } from "../domain/comandos.js";
import type { IncomingMessage, OutgoingMessage } from "../channels/core/types.js";
import * as M from "./messages.js";


// ─── Logger contextual simple ────────────────────────────────────────

type LogCtx = {
  tenantId: string;
  chatId: string;
  estado: string;
  tz: string;            // timezone del tenant (ej. "America/Santo_Domingo")
  updateId?: string;
};

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

// ─── Detección de cortesía/cierre conversacional ─────────────────────
// Estas palabras NO requieren LLM, responden con plantilla.

const PALABRAS_CORTESIA = [
  "gracias", "muchas gracias", "thank you", "thanks", "ty",
  "ok", "okay", "okey", "vale", "perfecto", "listo", "bien",
  "👍", "🙏", "✅", "👌",
];

function esCortesia(texto: string): boolean {
  const limpio = texto.toLowerCase().trim().replace(/[!.?¡¿]/g, "");
  if (limpio.length === 0 || limpio.length > 30) return false;
  return PALABRAS_CORTESIA.some(p => limpio === p || limpio === `${p}!`);
}

// ─── Nombre de la asistente virtual ──────────────────────────────────
// Default global "María Salud". Cada tenant puede sobreescribirlo poniendo
// `tenants.configuracion = {"asistente_nombre": "Otra Asistente"}`.
// Si el campo está vacío o inválido, usamos el default.

const ASISTENTE_NOMBRE_DEFAULT = "María Salud";

function nombreAsistenteDe(tenant: Tenant | null): string {
  const v = tenant?.configuracion?.["asistente_nombre"];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return ASISTENTE_NOMBRE_DEFAULT;
}

/**
 * Lee el FAQ del tenant desde `tenants.configuracion.faq`.
 * Devuelve `undefined` si no está configurado (el prompt builder maneja eso).
 * Si la estructura no es un objeto plano, también devuelve undefined defensivamente.
 */
function faqDelTenant(tenant: Tenant | null): Record<string, unknown> | undefined {
  const raw = tenant?.configuracion?.["faq"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
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

const TZ_FALLBACK = "America/Santo_Domingo";

export async function handleIncoming(msg: IncomingMessage): Promise<OutgoingMessage[]> {
  // Cargar tenant una vez por request para tener su timezone
  let tenant: Tenant | null = null;
  try {
    tenant = await tenantsRepo.findById(msg.tenantId);
  } catch (err) {
    console.error(`[orch] no pude cargar tenant ${msg.tenantId}:`, err);
  }
  const tz = tenant?.timezone || TZ_FALLBACK;

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
    tz,
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
      return await handleCommand(msg, sesion, ctx, tenant);
    }

    // 1b. Texto que PARECE un comando pero Telegram no lo registró como tal
    // (ej: /Star mal escrito, /menu sin que el bot tenga esa /command registrada).
    // Lo interceptamos para no caer en "no entendí" frustrante.
    if (msg.type === "text" && msg.text) {
      const cmdLike = textoComoComando(msg.text);
      if (cmdLike) {
        logInfo(ctx, `texto interpretado como comando: ${cmdLike}`);
        return await handleCommand(
          { ...msg, type: "command", command: cmdLike },
          sesion,
          ctx,
          tenant,
        );
      }
    }

    // 2. Detección universal de cancelación (texto libre)
    if (msg.type === "text" && msg.text && quiereCancelar(msg.text)
        && sesion.estado !== "IDLE") {
      logInfo(ctx, "usuario quiere cancelar flujo");
      const fresh = await sessionManager.resetToIdle(sesion.id);
      return [
        { kind: "text", text: M.flujoCancelado() },
        await menuPrincipal(msg.tenantId, fresh, tenant),
      ];
    }

    // 3. Click de botón (determinístico)
    if (msg.type === "button_click" && msg.buttonData) {
      return await handleButton(msg, sesion, ctx, tenant);
    }

    // 4. Texto libre
    if (msg.type === "text" && msg.text) {
      return await handleText(msg, sesion, ctx, tenant);
    }

    return [{ kind: "text", text: M.noEntendi() }];
  } catch (err) {
    logError(ctx, "error no controlado en handleIncoming", err);
    try {
      await sessionManager.resetToIdle(sesion.id);
    } catch {
      // ya estamos en path de error
    }
    return [{ kind: "text", text: M.errorTecnico() }];
  }
}


// ─── Comandos ────────────────────────────────────────────────────────

async function handleCommand(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  ctx: LogCtx,
  tenant: Tenant | null,
): Promise<OutgoingMessage[]> {
  const cmd = msg.command;

  if (cmd === "start" || cmd === "menu") {
    if (sesion.estado !== "IDLE") {
      logInfo(ctx, "/start a mitad de flujo, pidiendo confirmación");
      return [{
        kind: "buttons",
        text: M.reseteoConfirmar(),
        buttons: M.opcionesReseteo,
      }];
    }
    const fresh = await sessionManager.resetToIdle(sesion.id);
    return [await menuPrincipal(msg.tenantId, fresh, tenant)];
  }

  if (cmd === "cancelar" || cmd === "salir") {
    await sessionManager.resetToIdle(sesion.id);
    return [{ kind: "text", text: M.flujoCancelado() }];
  }

  return [{ kind: "text", text: M.noEntendi() }];
}


// ─── Botones ─────────────────────────────────────────────────────────

async function handleButton(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  ctx: LogCtx,
  tenant: Tenant | null,
): Promise<OutgoingMessage[]> {
  const data = msg.buttonData!;
  const colon = data.indexOf(":");
  const tipo = colon >= 0 ? data.slice(0, colon) : data;
  const valor = colon >= 0 ? data.slice(colon + 1) : "";

  try {
    switch (tipo) {
      case "intent":     return await handleIntentButton(msg, sesion, valor, ctx, tenant);
      case "profesional":return await handleProfesionalButton(sesion, valor, ctx);
      case "sede":       return await handleSedeButton(sesion, valor, ctx);
      case "servicio":   return await handleServicioButton(sesion, valor, ctx);
      case "fecha":      return await handleFechaButton(sesion, valor, ctx);
      case "slot":       return await handleSlotButton(sesion, valor, ctx);
      case "tipopago":   return await handleTipoPagoButton(sesion, valor, ctx);
      case "confirmar":  return await handleConfirmar(msg, sesion, valor, ctx);
      case "cancelar_cita": return await handleCancelarCitaButton(msg, sesion, valor, ctx);
      case "menu": {
        const fresh = await sessionManager.resetToIdle(sesion.id);
        return [await menuPrincipal(msg.tenantId, fresh, tenant)];
      }
      case "reset":
        if (valor === "si") {
          const f = await sessionManager.resetToIdle(sesion.id);
          return [
            { kind: "text", text: M.flujoCancelado() },
            await menuPrincipal(msg.tenantId, f, tenant),
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
  ctx: LogCtx,
  tenant: Tenant | null,
): Promise<OutgoingMessage[]> {
  if (valor === "agendar" || valor === "horarios") {
    return await iniciarFlujoAgendar(msg.tenantId, sesion, ctx, tenant, false);
  }
  if (valor === "agendar_otra") {
    // Saltar verificación de cita activa (el usuario quiere expresamente otra)
    return await iniciarFlujoAgendar(msg.tenantId, sesion, ctx, tenant, true);
  }

  // ¿Tenemos teléfono recordado? Saltar el paso de pedirlo.
  const telefonoConocido = sesion.contexto["paciente_telefono_conocido"] as string | undefined;

  if (valor === "consultar") {
    if (telefonoConocido) {
      logInfo(ctx, `usando teléfono conocido para consultar: ${telefonoConocido}`);
      return await mostrarCitasDelPaciente(msg.tenantId, telefonoConocido, "consultar", sesion, ctx);
    }
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "consultar" });
    return [{ kind: "text", text: M.pidiendoTelefonoConsulta() }];
  }
  if (valor === "cancelar") {
    if (telefonoConocido) {
      logInfo(ctx, `usando teléfono conocido para cancelar: ${telefonoConocido}`);
      return await mostrarCitasDelPaciente(msg.tenantId, telefonoConocido, "cancelar", sesion, ctx);
    }
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "cancelar" });
    return [{ kind: "text", text: M.pidiendoTelefonoCancelar() }];
  }
  logWarn(ctx, `intent button valor desconocido: ${valor}`);
  return [{ kind: "text", text: M.noEntendi() }];
}


async function iniciarFlujoAgendar(
  tenantId: string,
  sesion: SesionConversacion,
  ctx: LogCtx,
  _tenant: Tenant | null,
  forzarNueva = false,
): Promise<OutgoingMessage[]> {
  // Antes de empezar el flujo: si el paciente ya tiene cita activa (lo conocemos
  // por el teléfono de memoria), preguntamos si quiere otra cita adicional o
  // reagendar la existente. Esto evita que agende doble por error.
  if (!forzarNueva) {
    const telConocido = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
    if (telConocido) {
      try {
        const citas = await consultarCitasActivasPorTelefono(tenantId, telConocido);
        if (citas.length > 0) {
          const c = citas[0];
          logInfo(ctx, "paciente ya tiene cita activa, ofreciendo opciones", { codigo: c.codigo });
          return [{
            kind: "buttons",
            text: M.yaTienesCitaActiva(
              formatFechaHora(c.iniciaEn, ctx.tz),
              c.servicioNombre,
              c.codigo,
            ),
            buttons: M.opcionesYaTieneCita,
          }];
        }
      } catch (err) {
        logWarn(ctx, "no pude verificar citas activas (continuando)", { err: String(err) });
      }
    }
  }

  const profesionales = await profesionalesRepo.listarActivos(tenantId);
  if (profesionales.length === 0) {
    logWarn(ctx, "no hay profesionales activos");
    return [{ kind: "text", text: "No hay profesionales disponibles ahora mismo." }];
  }

  // Caso 1: un solo profesional → saltamos al paso de sede
  if (profesionales.length === 1) {
    return await mostrarSedesParaProfesional(tenantId, profesionales[0], sesion, ctx);
  }

  // Caso 2: múltiples profesionales → preguntar a cuál quiere ir
  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_PROFESIONAL", {});
  return [{
    kind: "buttons",
    text: M.eligiendoProfesional(),
    buttons: profesionales.slice(0, 8).map(p => ({
      label: `${p.prefijo} ${p.nombre} ${p.apellido}`,
      data: `profesional:${p.id}`,
    })),
  }];
}


/**
 * Maneja el caso en que el paciente mencionó un profesional por nombre.
 * Llamada desde handleIdleConLLM cuando el LLM devuelve la tool `buscar_profesional`
 * + intención `agendar`.
 *
 * Tres casos:
 *   - 0 matches  → mensaje natural y ofrece flujo normal (lista todos los profesionales)
 *   - 1 match    → salta directo a sedes (respetando chequeo de cita activa via iniciarFlujoAgendar)
 *   - 2-8 match  → muestra botones SOLO con esos matches, reusando el handler `profesional`
 *   - 9+ match   → pide al usuario ser más específico
 *
 * IMPORTANTE: cuando hay 1 match, NO saltamos `iniciarFlujoAgendar` directamente porque
 * eso saltaría también el chequeo de "ya tienes cita activa". Lo que hacemos es delegar
 * a iniciarFlujoAgendar pasando un hint en el contexto, pero como iniciarFlujoAgendar
 * no soporta ese hint hoy y no queremos modificarlo, llamamos a mostrarSedesParaProfesional
 * solo después de hacer manualmente el chequeo de cita activa.
 */
async function handleBusquedaProfesional(
  tenantId: string,
  sesion: SesionConversacion,
  ctx: LogCtx,
  tenant: Tenant | null,
  nombreQuery: string,
): Promise<OutgoingMessage[]> {
  let matches: Array<{ id: string; prefijo: string; nombre: string; apellido: string }>;
  try {
    matches = await profesionalesRepo.buscarPorNombre(tenantId, nombreQuery, 10);
  } catch (err) {
    logWarn(ctx, "búsqueda de profesional falló, fallback a flujo normal", { err: String(err) });
    return await iniciarFlujoAgendar(tenantId, sesion, ctx, tenant, false);
  }

  // Caso 0 matches: explicar y caer al flujo normal con la lista completa
  if (matches.length === 0) {
    logInfo(ctx, `búsqueda sin matches para "${nombreQuery}"`);
    const todos = await profesionalesRepo.listarActivos(tenantId);
    if (todos.length === 0) {
      return [{ kind: "text", text: "No hay profesionales disponibles ahora mismo." }];
    }
    // Si hay un solo profesional total, vamos directo
    if (todos.length === 1) {
      return [
        { kind: "text", text: `No encontré a "${nombreQuery}", pero te puedo ayudar con *${todos[0].prefijo} ${todos[0].nombre} ${todos[0].apellido}*.` },
        ...(await mostrarSedesParaProfesional(tenantId, todos[0], sesion, ctx)),
      ];
    }
    await sessionManager.transitionTo(sesion.id, "ELIGIENDO_PROFESIONAL", {});
    return [
      { kind: "text", text: `No encontré a "${nombreQuery}". Estos son los profesionales disponibles:` },
      {
        kind: "buttons",
        text: M.eligiendoProfesional(),
        buttons: todos.slice(0, 8).map(p => ({
          label: `${p.prefijo} ${p.nombre} ${p.apellido}`,
          data: `profesional:${p.id}`,
        })),
      },
    ];
  }

  // Caso 1 match exacto: respetar chequeo de cita activa antes de avanzar
  if (matches.length === 1) {
    const prof = matches[0];
    logInfo(ctx, `match único: ${prof.prefijo} ${prof.nombre} ${prof.apellido}`);

    // Chequeo de cita activa (mismo patrón que iniciarFlujoAgendar)
    const telConocido = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
    if (telConocido) {
      try {
        const citas = await consultarCitasActivasPorTelefono(tenantId, telConocido);
        if (citas.length > 0) {
          const c = citas[0];
          logInfo(ctx, "paciente con cita activa, ofreciendo opciones", { codigo: c.codigo });
          return [{
            kind: "buttons",
            text: M.yaTienesCitaActiva(
              formatFechaHora(c.iniciaEn, ctx.tz),
              c.servicioNombre,
              c.codigo,
            ),
            buttons: M.opcionesYaTieneCita,
          }];
        }
      } catch (err) {
        logWarn(ctx, "no pude verificar citas activas (continuando)", { err: String(err) });
      }
    }

    // Sin cita activa → vamos directo a sedes con el profesional encontrado
    return [
      { kind: "text", text: `¡Perfecto! Te ayudo a agendar con *${prof.prefijo} ${prof.nombre} ${prof.apellido}* 🙌` },
      ...(await mostrarSedesParaProfesional(tenantId, prof, sesion, ctx)),
    ];
  }

  // Caso 9+ matches: pedir aclaración
  if (matches.length > 8) {
    logInfo(ctx, `demasiados matches (${matches.length}) para "${nombreQuery}"`);
    return [{
      kind: "text",
      text: `Encontré varios profesionales que coinciden con "${nombreQuery}". ¿Puedes darme un poco más de detalle? (nombre completo o apellido)`,
    }];
  }

  // Caso 2-8 matches: ofrecer botones para elegir
  logInfo(ctx, `${matches.length} matches para "${nombreQuery}"`);
  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_PROFESIONAL", {});

  const lista = matches
    .map(p => `• *${p.prefijo} ${p.nombre} ${p.apellido}*`)
    .join("\n");

  return [{
    kind: "buttons",
    text: `Tengo ${matches.length} profesionales que coinciden con "${nombreQuery}":\n\n${lista}\n\n¿Cuál prefieres?`,
    buttons: matches.map(p => ({
      label: `${p.prefijo} ${p.nombre} ${p.apellido}`,
      data: `profesional:${p.id}`,
    })),
  }];
}


async function mostrarSedesParaProfesional(
  tenantId: string,
  profesional: { id: string; prefijo: string; nombre: string; apellido: string },
  sesion: SesionConversacion,
  ctx: LogCtx
): Promise<OutgoingMessage[]> {
  const sedes = await profesionalesRepo.listarSedesPorProfesional(tenantId, profesional.id);
  if (sedes.length === 0) {
    logWarn(ctx, `profesional ${profesional.id} sin sedes activas`);
    return [{ kind: "text", text: "Ese profesional no tiene sedes disponibles ahora." }];
  }

  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_SEDE", {
    profesional_id: profesional.id,
  });

  const profDisplay = `${profesional.prefijo} ${profesional.nombre} ${profesional.apellido}`;

  // Si solo hay una sede, igual mostramos el botón para que el usuario confirme
  // (más claridad que saltarse el paso silenciosamente).
  return [{
    kind: "buttons",
    text: M.eligiendoSede(profDisplay),
    buttons: sedes.map(s => ({
      label: s.sede.ciudad ? `${s.sede.nombre} (${s.sede.ciudad})` : s.sede.nombre,
      data: `sede:${s.profesionalSede.id}`,
    })),
  }];
}


async function handleProfesionalButton(
  sesion: SesionConversacion,
  profesionalId: string,
  ctx: LogCtx,
): Promise<OutgoingMessage[]> {
  const prof = await profesionalesRepo.findById(sesion.tenant_id, profesionalId);
  if (!prof) {
    logWarn(ctx, `profesional no encontrado: ${profesionalId}`);
    return [{ kind: "text", text: "Ese profesional no está disponible." }];
  }
  return await mostrarSedesParaProfesional(sesion.tenant_id, prof, sesion, ctx);
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
    buttons: proximosDiasHabiles(5, ctx.tz).map(d => ({
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
      text: M.diaSinHorarios(formatFechaLarga(fecha)),
      buttons: proximosDiasHabiles(5, ctx.tz).map(d => ({ label: d.label, data: `fecha:${d.iso}` })),
    }];
  }

  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_HORA", {
    fecha_seleccionada: fecha,
  });

  return [{
    kind: "buttons",
    text: M.eligiendoHora(formatFechaLarga(fecha)),
    buttons: slots.slice(0, 8).map(s => ({
      label: formatHoraCorta(s.iniciaEn, ctx.tz),
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

  const fechaHora = formatFechaHora(ctxValidado.inicia_en, ctx.tz);
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

  // Recargar sesión fresca por si hubo races (otro click rápido)
  const sesionFresca = await sessionManager.loadFresh(sesion.id);
  if (!sesionFresca) {
    logError(ctx, "sesión desapareció antes de confirmar", null);
    return [{ kind: "text", text: M.errorTecnico() }];
  }

  const ctxValidado = validarContextoConfirmacion(sesionFresca.contexto);
  if (!ctxValidado) {
    logError(ctx, "contexto incompleto en confirmar", sesionFresca.contexto);
    await sessionManager.resetToIdle(sesion.id);
    return [{ kind: "text", text: "Faltan datos. Empecemos de nuevo. Usa /start." }];
  }

  // Re-validar que el slot siga libre (alguien pudo haberlo agarrado mientras
  // el paciente miraba el resumen). Si ya no, redirigimos al paso de hora.
  try {
    const fechaISO = ctxValidado.inicia_en.slice(0, 10);
    const slotsLibres = await listarHorariosLibres({
      profesionalSedeId: ctxValidado.profesional_sede_id,
      fecha: fechaISO,
    });
    const slotSigueLibre = slotsLibres.some(
      s => s.iniciaEn === ctxValidado.inicia_en && s.cuposLibres > 0
    );
    if (!slotSigueLibre) {
      logWarn(ctx, "slot ya no disponible al confirmar, ofreciendo otra hora");
      // Volver al paso de elegir hora con los slots actualizados
      await sessionManager.transitionTo(sesion.id, "ELIGIENDO_HORA", {});
      if (slotsLibres.length === 0) {
        return [{
          kind: "buttons",
          text: `Uy, ese horario ya lo tomaron y no me quedan más libres ese día. ¿Otro día?`,
          buttons: proximosDiasHabiles(5, ctx.tz).map(d => ({ label: d.label, data: `fecha:${d.iso}` })),
        }];
      }
      return [{
        kind: "buttons",
        text: `Uy, ese horario lo tomaron mientras decidías 😕 Estos están libres todavía:`,
        buttons: slotsLibres.slice(0, 8).map(s => ({
          label: formatHoraCorta(s.iniciaEn, ctx.tz),
          data: `slot:${s.iniciaEn}`,
        })),
      }];
    }
  } catch (err) {
    // Si la re-validación falla por DB, dejamos seguir y que fn_agendar decida
    logWarn(ctx, "re-validación de slot falló, continuamos", { err: String(err) });
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

    // Reset + guardar memoria del paciente en una sola operación atómica.
    // (resetToIdle limpia, transitionTo pone los _conocido en jsonb merge)
    await sessionManager.resetToIdle(sesion.id, false);
    await sessionManager.transitionTo(sesion.id, "IDLE", {
      paciente_telefono_conocido: ctxValidado.paciente_telefono,
      paciente_nombre_conocido: ctxValidado.paciente_nombre,
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


// ─── Texto libre ─────────────────────────────────────────────────────

async function handleText(
  msg: IncomingMessage,
  sesion: SesionConversacion,
  ctx: LogCtx,
  tenant: Tenant | null,
): Promise<OutgoingMessage[]> {
  await sessionManager.appendUser(sesion.id, msg.text!);

  // Atajo: si es cortesía ("gracias", "ok", "perfecto"), responder sin LLM
  if (sesion.estado === "IDLE" && esCortesia(msg.text!)) {
    return [{ kind: "text", text: M.respuestaCortesia() }];
  }

  // Estados que esperan input específico
  if (sesion.estado === "PIDIENDO_NOMBRE") {
    return await handlePidiendoNombre(msg.text!, sesion, ctx);
  }
  if (sesion.estado === "PIDIENDO_TELEFONO") {
    return await handlePidiendoTelefono(msg, sesion, ctx, tenant);
  }

  // Otros estados con texto libre: si es IDLE, usar LLM; si no, mostrar menú
  if (sesion.estado === "IDLE") {
    return await handleIdleConLLM(msg, sesion, ctx, tenant);
  }

  // El usuario escribió texto en un estado que esperaba click (CANCELANDO_CITA,
  // ELIGIENDO_SEDE, etc.). Probablemente cambió de opinión o quiere algo nuevo.
  //
  // Estrategia: hacer un reset suave a IDLE y dejar que el LLM procese el texto
  // como cualquier mensaje normal. Esto permite cambios de opinión naturales
  // ("quiero cancelar" → ve botones → "mejor agendar otra" → bot agenda).
  //
  // Preservamos memoria del paciente (teléfono/nombre conocidos) en el reset.
  logInfo(ctx, `texto libre en estado ${sesion.estado} → soft-reset y procesar con LLM`);
  const sesionFresca = await sessionManager.resetToIdle(sesion.id, true);
  return await handleIdleConLLM(msg, sesionFresca, ctx, tenant);
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
  ctx: LogCtx,
  tenant: Tenant | null,
): Promise<OutgoingMessage[]> {
  const phone = validatePhoneDO(msg.text!);
  if (!phone.valid || !phone.normalized) {
    const intentos = (sesion.contexto["intentos_invalidos"] as number ?? 0) + 1;
    await sessionManager.transitionTo(sesion.id, sesion.estado, { intentos_invalidos: intentos });

    if (intentos >= 3) {
      logWarn(ctx, `usuario frustrado (${intentos} intentos), ofreciendo salida`);
      const fresh = await sessionManager.resetToIdle(sesion.id);
      return [
        { kind: "text", text: M.ofrecerSalida() },
        await menuPrincipal(msg.tenantId, fresh, tenant),
      ];
    }
    return [{ kind: "text", text: M.telefonoInvalido(phone.reason ?? "teléfono inválido") }];
  }

  // Reset contador de intentos
  await sessionManager.transitionTo(sesion.id, sesion.estado, {
    paciente_telefono: phone.normalized,
    paciente_telefono_conocido: phone.normalized,
    intentos_invalidos: 0,
  });

  const intencion = sesion.contexto["intencion"];
  if (intencion === "consultar" || intencion === "cancelar") {
    return await mostrarCitasDelPaciente(msg.tenantId, phone.normalized, intencion as string, sesion, ctx);
  }

  // Flujo agendar
  await sessionManager.transitionTo(sesion.id, "ELIGIENDO_TIPO_PAGO", {});

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
  ctx: LogCtx,
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
    fechaHora: formatFechaHora(c.iniciaEn, ctx.tz),
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
  ctx: LogCtx,
  tenant: Tenant | null,
): Promise<OutgoingMessage[]> {
  let intencionDetectada: string | null = null;
  let confianzaIntencion = 0;
  let textoLLM = "";

  try {
    const profesionales = await profesionalesRepo.listarActivos(msg.tenantId);

    // Cargamos las aseguradoras de cada uno (en paralelo, hasta 5 doctores)
    const profesionalesParaPrompt = profesionales.slice(0, 5);
    const aseguradorasPorDoctor = await Promise.all(
      profesionalesParaPrompt.map(async p => {
        try {
          const arr = await profesionalesRepo.listarAseguradorasDeProfesional(p.id);
          return arr.map(a => a.nombre);
        } catch {
          return [] as string[];
        }
      })
    );

    const profesionalesResumen = profesionalesParaPrompt.map((p, i) => ({
      display: `${p.prefijo} ${p.nombre} ${p.apellido}`,
      especialidad: p.especialidad ?? undefined,
      bio: p.bio_corta,
      anosExperiencia: p.anos_experiencia,
      whatsapp: p.telefono,
      aseguradoras: aseguradorasPorDoctor[i],
    }));

    // Sedes con datos completos (dirección, teléfono, ubicación, extensión)
    let sedesResumen: Array<{
      nombre: string;
      ciudad?: string | null;
      direccion?: string | null;
      telefono?: string | null;
      tieneUbicacion?: boolean;
      extension?: string | null;
    }> = [];
    // Servicios con precios y duración
    let serviciosResumen: Array<{
      nombre: string;
      descripcion?: string | null;
      precio?: number;
      duracionMin?: number;
      moneda?: string;
    }> = [];
    // Horarios resumidos del primer profesional/sede como referencia
    let horariosResumen: Array<{ texto: string }> = [];

    if (profesionales.length > 0) {
      const primero = profesionales[0];
      try {
        const sedes = await profesionalesRepo.listarSedesPorProfesional(msg.tenantId, primero.id);
        sedesResumen = sedes.map(s => ({
          nombre: s.sede.nombre,
          ciudad: s.sede.ciudad,
          direccion: s.sede.direccion,
          telefono: s.sede.telefono,
          tieneUbicacion: s.sede.latitud !== null && s.sede.longitud !== null,
          extension: s.profesionalSede.extension,
        }));
        if (sedes.length > 0) {
          const primeraPS = sedes[0].profesionalSede;
          // Servicios públicos del primer profesional_sede
          try {
            const servs = await profesionalesRepo.listarServiciosPublicos(primeraPS.id);
            serviciosResumen = servs.slice(0, 12).map(s => ({
              nombre: s.nombre,
              descripcion: s.descripcion_publica,
              precio: s.precio,
              duracionMin: s.duracion_min,
              moneda: s.moneda,
            }));
          } catch (err) {
            logWarn(ctx, "no pude listar servicios para prompt", { err: String(err) });
          }
          // Horarios de atención
          try {
            const horarios = await profesionalesRepo.listarHorariosAtencion(primeraPS.id);
            horariosResumen = resumirHorariosAtencion(horarios).map(t => ({ texto: t }));
          } catch (err) {
            logWarn(ctx, "no pude listar horarios para prompt", { err: String(err) });
          }
        }
      } catch (err) {
        logWarn(ctx, "no pude listar sedes para prompt", { err: String(err) });
      }
    }

    // Si tenemos teléfono conocido, buscar cita activa para enriquecer el prompt
    let citaActivaResumen: { servicio: string; fechaHora: string; codigo: string } | undefined;
    const telConocido = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
    if (telConocido) {
      try {
        const citas = await consultarCitasActivasPorTelefono(msg.tenantId, telConocido);
        if (citas.length > 0) {
          const c = citas[0];
          citaActivaResumen = {
            servicio: c.servicioNombre,
            fechaHora: formatFechaHora(c.iniciaEn, ctx.tz),
            codigo: c.codigo,
          };
        }
      } catch {
        // si falla la consulta de cita, no es crítico
      }
    }

    const nombreConocido = sesion.contexto["paciente_nombre_conocido"] as string | undefined;

    const systemPrompt = buildSystemPrompt({
      nombreClinica: tenant?.nombre_comercial ?? "la clínica",
      tipoEntidad: tenant?.tipo_entidad ?? "individual",
      profesionales: profesionalesResumen,
      sedes: sedesResumen,
      servicios: serviciosResumen,
      horarios: horariosResumen,
      estadoSesion: "IDLE",
      pacienteNombre: nombreConocido,
      citaActiva: citaActivaResumen,
      nombreAsistente: nombreAsistenteDe(tenant),
      faq: faqDelTenant(tenant),
    });

    const llmRes = await callLLM({
      systemPrompt,
      history: extraerHistorialParaLLM(sesion.historial, msg.text!),
      userMessage: msg.text!,
      tools: ALL_TOOLS,
      maxTokens: 512,
    });

    textoLLM = llmRes.text.trim();

    // Guardamos la respuesta del asistente para que en el próximo turno
    // el LLM tenga el contexto completo. Solo si hay texto real (los flujos
    // determinísticos de botones se manejan más abajo, fuera de este try).
    if (textoLLM.length > 0) {
      try {
        await sessionManager.appendAssistant(sesion.id, textoLLM);
      } catch (err) {
        // No crítico — si falla el append, el LLM responderá igual el próximo turno
        logWarn(ctx, "no pude guardar respuesta del asistente al historial", { err: String(err) });
      }
    }

    const intencionTool = llmRes.toolUses.find(t => t.name === "detectar_intencion");
    if (intencionTool) {
      const intencion = intencionTool.input["intencion"] as string;
      const confianza = (intencionTool.input["confianza"] as number) ?? 0;
      if (confianza >= 0.7) {
        intencionDetectada = intencion;
        confianzaIntencion = confianza;
      }
    }

    // ¿El LLM detectó que el paciente mencionó un profesional por nombre?
    const buscarProfTool = llmRes.toolUses.find(t => t.name === "buscar_profesional");
    if (buscarProfTool) {
      const nombreQuery = (buscarProfTool.input["nombre_query"] as string ?? "").trim();
      // Solo aplicamos la búsqueda si la intención clara es agendar.
      // Si el paciente solo está conversando o tiene otra intención, ignoramos.
      if (nombreQuery.length >= 2
          && (intencionDetectada === "agendar" || intencionDetectada === "horarios")) {
        logInfo(ctx, `búsqueda de profesional por nombre`, { query: nombreQuery });
        return await handleBusquedaProfesional(msg.tenantId, sesion, ctx, tenant, nombreQuery);
      }
    }

    logInfo(ctx, `LLM resp`, {
      tieneTexto: textoLLM.length > 0,
      intencion: intencionDetectada,
      confianza: confianzaIntencion,
    });

  } catch (err: unknown) {
    if (err instanceof LLMUnavailableError) {
      logWarn(ctx, "LLM no disponible, fallback a menú", { msg: err.message });
    } else {
      logError(ctx, "error inesperado en LLM, fallback a menú", err);
    }
    return [await menuPrincipal(msg.tenantId, sesion, tenant)];
  }

  // Manejar intención detectada
  if (intencionDetectada === "agendar" || intencionDetectada === "horarios") {
    return await iniciarFlujoAgendar(msg.tenantId, sesion, ctx, tenant);
  }
  if (intencionDetectada === "consultar") {
    const tel = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
    if (tel) {
      logInfo(ctx, "usando teléfono conocido para consultar", { tel });
      return await mostrarCitasDelPaciente(msg.tenantId, tel, "consultar", sesion, ctx);
    }
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "consultar" });
    return [{ kind: "text", text: M.pidiendoTelefonoConsulta() }];
  }
  if (intencionDetectada === "cancelar") {
    const tel = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
    if (tel) {
      logInfo(ctx, "usando teléfono conocido para cancelar", { tel });
      return await mostrarCitasDelPaciente(msg.tenantId, tel, "cancelar", sesion, ctx);
    }
    await sessionManager.transitionTo(sesion.id, "PIDIENDO_TELEFONO", { intencion: "cancelar" });
    return [{ kind: "text", text: M.pidiendoTelefonoCancelar() }];
  }

  // Sin intención clara: si el LLM dio una respuesta natural, ÚSALA.
  //
  // Filosofía:
  //   - Si el LLM ya respondió con texto natural, ese mensaje BASTA. No
  //     mandamos el menú detrás porque se siente robótico (el LLM ya
  //     suele cerrar con "¿en qué más te ayudo?").
  //   - Si el LLM no devolvió texto (caso raro: tool sin texto + intención
  //     no procesada) o el texto es muy genérico, sí mostramos el menú
  //     para que el usuario tenga botones para avanzar.
  if (textoLLM.length > 0) {
    return [{ kind: "text", text: textoLLM }];
  }

  return [await menuPrincipal(msg.tenantId, sesion, tenant)];
}


// ─── Menú principal ──────────────────────────────────────────────────

async function menuPrincipal(
  tenantId: string,
  sesion: SesionConversacion,
  tenantPreloaded?: Tenant | null,
): Promise<OutgoingMessage> {
  const tenant = tenantPreloaded !== undefined
    ? tenantPreloaded
    : await tenantsRepo.findById(tenantId);
  const nombre = tenant?.nombre_comercial ?? "CitasMed";
  const tz = tenant?.timezone || "America/Santo_Domingo";
  const asistente = nombreAsistenteDe(tenant);

  // Si conocemos al paciente y tiene cita activa, saludo enriquecido
  const telConocido = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
  if (telConocido) {
    try {
      const citas = await consultarCitasActivasPorTelefono(tenantId, telConocido);
      if (citas.length > 0) {
        const c = citas[0];
        return {
          kind: "buttons",
          text: M.saludoConCitaPendiente(nombre, formatFechaHora(c.iniciaEn, tz), c.servicioNombre, asistente),
          buttons: M.opcionesMenuConCitaPendiente,
        };
      }
    } catch {
      // si falla, saludo genérico
    }
  }

  return {
    kind: "buttons",
    text: M.saludoBienvenida(nombre, asistente),
    buttons: M.opcionesMenu,
  };
}
