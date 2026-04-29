// src/application/orchestrator.ts
// Entry point. SOLO wiring.
//
// Responsabilidades:
//   1. Cargar tenant + sesión
//   2. Normalizar IncomingMessage → EventoInterno
//   3. Llamar al dispatcher para obtener HandlerConfig
//   4. Enrutar al flow/intent correcto
//   5. Ejecutar los Effect[] devueltos
//   6. Error boundary global
//
// Una sola razón de cambio: cambiar CÓMO se conectan las piezas.
// Nada de lógica de negocio aquí.

import { sessionManager } from "./session-manager.js";
import { tenantsRepo, profesionalesRepo } from "../persistence/repositories/index.js";
import type { SesionConversacion, Tenant } from "../persistence/repositories/index.js";
import type { IncomingMessage, OutgoingMessage } from "../channels/core/types.js";
import type { FlowContext } from "./types.js";
import { logInfo, logWarn, logError } from "./types.js";
import { normalizeEvent } from "./dispatcher/events.js";
import { dispatch } from "./dispatcher/index.js";
import { runEffects, fxSend, fxReset } from "./effects/runner.js";
import { nombreAsistenteDe, tzDe } from "./config/resolver.js";
import { renderMenu } from "./presenters/menu.js";
import { consultarCitasActivasPorTelefono } from "./use-cases/index.js";
import { formatFechaHora } from "../domain/datetime.js";
import * as M from "./messages.js";

// ─── Flows ────────────────────────────────────────────────────────────

import {
  iniciarFlujoAgendar,
  handleIdentificarDoctor,
  buscarProfesional,
  handleProfesionalButton,
  handleAgendarCon,
  handleInfoDoctor,
  handleBuscarOtro,
  seleccionarServicio,
  seleccionarServicioButton,
  seleccionarFecha,
  seleccionarSlot,
  recibirNombre,
  recibirTelefono,
  seleccionarTipoPago,
  confirmarCita,
} from "./flows/agendar/index.js";
import { mostrarCitasConsulta, pedirTelefonoConsulta } from "./flows/consultar/index.js";
import { mostrarCitasCancelar, pedirTelefonoCancelar, ejecutarCancelacion } from "./flows/cancelar/index.js";
import { handleLLM } from "./intents/llm-handler.js";

// ─── Constante ────────────────────────────────────────────────────────

const TZ_FALLBACK = "America/Santo_Domingo";

// ─── Entry point ─────────────────────────────────────────────────────

export async function handleIncoming(msg: IncomingMessage): Promise<OutgoingMessage[]> {
  // 1. Cargar recursos base
  let tenant: Tenant | null = null;
  try {
    tenant = await tenantsRepo.findById(msg.tenantId);
  } catch (err) {
    console.error(`[orch] no pude cargar tenant ${msg.tenantId}:`, err);
  }

  let sesion: SesionConversacion;
  try {
    sesion = await sessionManager.loadOrCreate({
      tenantId: msg.tenantId,
      canalConectadoId: msg.channelId,
      contactoExterno: msg.contactoExterno,
    });
  } catch (err) {
    console.error("[orch] falló loadOrCreate de sesión:", err);
    return [{ kind: "text", text: M.errorTecnico() }];
  }

  const tz = tzDe(tenant) ?? TZ_FALLBACK;
  const logCtx = {
    tenantId: msg.tenantId,
    chatId: msg.contactoExterno,
    estado: sesion.estado,
    tz,
    updateId: msg.externalMessageId,
  };

  logInfo(logCtx, `entrada type=${msg.type}`, {
    text: msg.text?.slice(0, 50),
    button: msg.buttonData,
    cmd: msg.command,
  });

  // 2. Construir FlowContext
  const ctx: FlowContext = {
    tenantId: msg.tenantId,
    sesionId: sesion.id,
    sesionEstado: sesion.estado,
    sesionContexto: sesion.contexto,
    logCtx,
  };

  try {
    // 3. Normalizar evento + dispatch
    const evento = normalizeEvent(msg);
    const handler = dispatch(sesion.estado, evento);

    logInfo(logCtx, `dispatch → ${handler.kind}`);

    // 4. Ejecutar handler
    const effects = await route(handler, ctx, msg, sesion, tenant);

    // 5. Aplicar efectos
    const { messages } = await runEffects(effects);

    // 6. Si no hay mensajes, mostrar menú (fallback silencioso)
    if (messages.length === 0) {
      const menu = await buildMenu(msg.tenantId, sesion, tenant, tz);
      return [menu];
    }

    // 7. Interceptar señal de delegación de teléfono (paso 05)
    return await interceptDelegation(messages, ctx, sesion, tenant);

  } catch (err) {
    logError(logCtx, "error no controlado en handleIncoming", err);
    try { await sessionManager.resetToIdle(sesion.id); } catch { /* ya en error */ }
    return [{ kind: "text", text: M.errorTecnico() }];
  }
}


// ─── Router central ───────────────────────────────────────────────────

async function route(
  handler: ReturnType<typeof dispatch>,
  ctx: FlowContext,
  msg: IncomingMessage,
  sesion: SesionConversacion,
  tenant: Tenant | null,
): Promise<ReturnType<typeof fxSend>[]> {
  const { kind, payload = {} } = handler;
  const p = payload as Record<string, unknown>;

  switch (kind) {

    // ─── Comandos ─────────────────────────────────────────────────

    case "command:start": {
      const slug = p["slug"] as string | undefined;
      const estadoActual = p["estadoActual"] as string;

      if (estadoActual !== "IDLE") {
        return [fxSend({
          kind: "buttons",
          text: M.reseteoConfirmar(),
          buttons: M.opcionesReseteo,
        })];
      }

      if (slug && /^[a-z0-9-]{2,80}$/.test(slug)) {
        const doctor = await profesionalesRepo.findBySlug(msg.tenantId, slug);
        if (doctor) {
          logInfo(ctx.logCtx, `deep-link slug="${slug}" → ${doctor.nombre} ${doctor.apellido}`);
          await sessionManager.resetToIdle(sesion.id);
          const asistente = nombreAsistenteDe(tenant);
          const display = `${doctor.prefijo} ${doctor.nombre} ${doctor.apellido}`;
          await sessionManager.transitionTo(sesion.id, "IDLE", {
            doctor_pre_identificado_id: doctor.id,
          });
          return [fxSend({
            kind: "buttons",
            text: M.saludoCitasMedConDoctor(display, doctor.especialidad, asistente),
            buttons: M.opcionesMenuConDoctor(doctor.id),
          })];
        }
        logWarn(ctx.logCtx, `deep-link slug="${slug}" no encontrado, saludo genérico`);
      }

      await sessionManager.resetToIdle(sesion.id);
      const menu = await buildMenu(msg.tenantId, sesion, tenant, ctx.logCtx.tz);
      return [fxSend(menu)];
    }

    case "command:cancelar": {
      await sessionManager.resetToIdle(sesion.id);
      return [fxSend({ kind: "text", text: M.flujoCancelado() })];
    }

    // ─── Globales ─────────────────────────────────────────────────

    case "global:cancelar_flujo": {
      await sessionManager.resetToIdle(sesion.id);
      const menu = await buildMenu(msg.tenantId, sesion, tenant, ctx.logCtx.tz);
      return [
        fxSend({ kind: "text", text: M.flujoCancelado() }),
        fxSend(menu),
      ];
    }

    case "global:menu": {
      await sessionManager.resetToIdle(sesion.id);
      const menu = await buildMenu(msg.tenantId, sesion, tenant, ctx.logCtx.tz);
      return [fxSend(menu)];
    }

    case "global:reset_confirm":
      return [fxSend({ kind: "text", text: "👍 Continuamos donde estábamos." })];

    case "global:reset_execute": {
      await sessionManager.resetToIdle(sesion.id);
      const menu = await buildMenu(msg.tenantId, sesion, tenant, ctx.logCtx.tz);
      return [
        fxSend({ kind: "text", text: M.flujoCancelado() }),
        fxSend(menu),
      ];
    }

    case "global:cortesia":
      return [fxSend({ kind: "text", text: M.respuestaCortesia() })];

    case "global:saludo": {
      const asistente = nombreAsistenteDe(tenant);
      return [fxSend({ kind: "text", text: M.saludoCitasMed(asistente) })];
    }

    case "global:soft_reset_then_llm": {
      logInfo(ctx.logCtx, `soft-reset desde ${p["estadoAnterior"]} → LLM`);
      const sesionFresca = await sessionManager.resetToIdle(sesion.id, true);
      const ctxFresco: FlowContext = { ...ctx, sesionEstado: sesionFresca.estado, sesionContexto: sesionFresca.contexto };
      return await executeLLM(ctxFresco, sesionFresca, p["texto"] as string, tenant);
    }

    // ─── Flows agendar ────────────────────────────────────────────

    case "flow:agendar:iniciar": {
      const r = await iniciarFlujoAgendar(ctx, tenant, p["forzarNueva"] as boolean);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:agendar:identificar": {
      await sessionManager.appendUser(sesion.id, msg.text ?? "");
      const r = await handleIdentificarDoctor(ctx, p["texto"] as string);
      if (r === null) return await executeLLM(ctx, sesion, msg.text ?? "", tenant);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:agendar:profesional_button": {
      const r = await handleProfesionalButton(ctx, p["profesionalId"] as string);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:agendar:agendar_con": {
      const r = await handleAgendarCon(ctx, p["profesionalId"] as string, p["forzar"] as boolean);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:agendar:info_doctor": {
      const r = await handleInfoDoctor(ctx, p["profesionalId"] as string);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:agendar:buscar_otro": {
      const r = await handleBuscarOtro(ctx, tenant);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:agendar:sede": {
      const r = await seleccionarServicio(ctx, p["psId"] as string);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:agendar:servicio": {
      const r = await seleccionarServicioButton(ctx, p["servicioId"] as string);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:agendar:fecha": {
      const r = await seleccionarFecha(ctx, p["fecha"] as string);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:agendar:slot": {
      // Este kind maneja 3 casos: slot, nombre, teléfono
      if (p["accion"] === "nombre") {
        const r = await recibirNombre(ctx, p["texto"] as string);
        return r.effects as ReturnType<typeof fxSend>[];
      }
      if (p["accion"] === "telefono") {
        const r = await recibirTelefono(ctx, p["texto"] as string);
        return r.effects as ReturnType<typeof fxSend>[];
      }
      const r = await seleccionarSlot(ctx, p["iniciaEn"] as string);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:agendar:tipo_pago": {
      const r = await seleccionarTipoPago(ctx, p["tipo"] as string);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:agendar:confirmar": {
      const r = await confirmarCita(ctx, msg.tenantId, p["valor"] as string);
      // Si es cancelación, añadir menú
      if (p["valor"] !== "si") {
        const menu = await buildMenu(msg.tenantId, sesion, tenant, ctx.logCtx.tz);
        return [...r.effects as ReturnType<typeof fxSend>[], fxSend(menu)];
      }
      return r.effects as ReturnType<typeof fxSend>[];
    }

    // ─── Flows consultar/cancelar ─────────────────────────────────

    case "flow:consultar:mostrar": {
      const tel = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
      if (tel) {
        const r = await mostrarCitasConsulta(ctx, tel);
        return r.effects as ReturnType<typeof fxSend>[];
      }
      const r = await pedirTelefonoConsulta(ctx);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:cancelar:mostrar": {
      const tel = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
      if (tel) {
        const r = await mostrarCitasCancelar(ctx, tel);
        return r.effects as ReturnType<typeof fxSend>[];
      }
      const r = await pedirTelefonoCancelar(ctx);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:cancelar:ejecutar": {
      const r = await ejecutarCancelacion(ctx, p["citaId"] as string);
      return r.effects as ReturnType<typeof fxSend>[];
    }

    case "flow:reagendar:iniciar":
      return [fxSend({ kind: "text", text: "El reagendamiento estará disponible pronto." })];

    // ─── LLM ─────────────────────────────────────────────────────

    case "intent:llm":
      await sessionManager.appendUser(sesion.id, msg.text ?? "");
      return await executeLLM(ctx, sesion, msg.text ?? "", tenant);

    default:
      logWarn(ctx.logCtx, `handler no reconocido: ${kind}`);
      return [fxSend({ kind: "text", text: M.noEntendi() })];
  }
}


// ─── LLM executor ────────────────────────────────────────────────────

async function executeLLM(
  ctx: FlowContext,
  sesion: SesionConversacion,
  texto: string,
  tenant: Tenant | null,
): Promise<ReturnType<typeof fxSend>[]> {
  const llmResult = await handleLLM({ ctx, sesion, texto, tenant });

  // Si el LLM quiere buscar un profesional, delegamos al flow
  if (llmResult.buscarProfesional) {
    const r = await buscarProfesional(ctx, tenant, llmResult.buscarProfesional.nombreQuery);
    return [...llmResult.result.effects, ...r.effects] as ReturnType<typeof fxSend>[];
  }

  // Manejar intención detectada
  const intencion = llmResult.intencionDetectada;

  if (intencion === "__fallback_menu") {
    return [fxSend(await buildMenu(ctx.tenantId, sesion, tenant, ctx.logCtx.tz))];
  }

  if (intencion === "agendar" || intencion === "horarios") {
    const r = await iniciarFlujoAgendar(ctx, tenant, false);
    return [...llmResult.result.effects, ...r.effects] as ReturnType<typeof fxSend>[];
  }

  if (intencion === "consultar") {
    const tel = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
    if (tel) {
      const r = await mostrarCitasConsulta(ctx, tel);
      return [...llmResult.result.effects, ...r.effects] as ReturnType<typeof fxSend>[];
    }
    const r = await pedirTelefonoConsulta(ctx);
    return [...llmResult.result.effects, ...r.effects] as ReturnType<typeof fxSend>[];
  }

  if (intencion === "cancelar") {
    const tel = sesion.contexto["paciente_telefono_conocido"] as string | undefined;
    if (tel) {
      const r = await mostrarCitasCancelar(ctx, tel);
      return [...llmResult.result.effects, ...r.effects] as ReturnType<typeof fxSend>[];
    }
    const r = await pedirTelefonoCancelar(ctx);
    return [...llmResult.result.effects, ...r.effects] as ReturnType<typeof fxSend>[];
  }

  return llmResult.result.effects as ReturnType<typeof fxSend>[];
}


// ─── Interceptor de delegación (paso 05 datos-paciente) ───────────────
// El paso de teléfono emite una señal __DELEGAR:intencion:telefono
// cuando el teléfono es válido y la intención es consultar/cancelar.

async function interceptDelegation(
  messages: OutgoingMessage[],
  ctx: FlowContext,
  sesion: SesionConversacion,
  tenant: Tenant | null,
): Promise<OutgoingMessage[]> {
  const idx = messages.findIndex(
    m => m.kind === "text" && m.text.startsWith("__DELEGAR:"),
  );
  if (idx === -1) return messages;

  const [, intencion, telefono] = (messages[idx] as { kind: "text"; text: string }).text.split(":");
  const restantes = messages.filter((_, i) => i !== idx);

  let delegados: OutgoingMessage[] = [];
  if (intencion === "consultar") {
    const r = await mostrarCitasConsulta(ctx, telefono);
    const { messages: ms } = await runEffects(r.effects);
    delegados = ms;
  } else if (intencion === "cancelar") {
    const r = await mostrarCitasCancelar(ctx, telefono);
    const { messages: ms } = await runEffects(r.effects);
    delegados = ms;
  }

  return [...restantes, ...delegados];
}


// ─── Builder del menú principal ───────────────────────────────────────
// Aquí viven las queries que menuPrincipal hacía antes.
// Resuelve datos y pasa al presenter puro.

async function buildMenu(
  tenantId: string,
  sesion: SesionConversacion,
  tenant: Tenant | null,
  tz: string,
): Promise<OutgoingMessage> {
  const asistente = nombreAsistenteDe(tenant);
  const tel = sesion.contexto["paciente_telefono_conocido"] as string | undefined;

  if (tel) {
    try {
      const citas = await consultarCitasActivasPorTelefono(tenantId, tel);
      if (citas.length > 0) {
        const c = citas[0];
        return renderMenu({
          nombreAsistente: asistente,
          citaActiva: {
            nombreClinica: tenant?.nombre_comercial ?? "CitasMed",
            fechaHora: formatFechaHora(c.iniciaEn, tz),
            servicioNombre: c.servicioNombre,
          },
        });
      }
    } catch { /* fallback a saludo genérico */ }
  }

  return renderMenu({ nombreAsistente: asistente });
}
