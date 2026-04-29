// src/application/flows/agendar/index.ts
// Orquestador interno del flow de agendamiento.
// Enruta al step correcto según el HandlerKind que viene del dispatcher.

import { profesionalesRepo } from "../../../persistence/repositories/index.js";
import * as M from "../../messages.js";
import type { FlowContext, FlowResult } from "../../types.js";
import { logWarn } from "../../types.js";
import { fxSend, fxTransition } from "../../effects/runner.js";
import { verificarCitaActiva } from "./guards/cita-activa.js";
import { identificarDoctor } from "./steps/01-identificar-doctor.js";
import { seleccionarSede } from "./steps/02-seleccionar-sede.js";
import { seleccionarServicio } from "./steps/03-seleccionar-servicio.js";
import {
  seleccionarServicioButton,
  seleccionarFecha,
  seleccionarSlot,
} from "./steps/04-seleccionar-hora.js";
import { recibirNombre, recibirTelefono } from "./steps/05-datos-paciente.js";
import { seleccionarTipoPago, confirmarCita } from "./steps/06-pago-confirmacion.js";
import { nombreAsistenteDe } from "../../config/resolver.js";
import type { Tenant } from "../../../persistence/repositories/index.js";

// ─── Iniciar flujo ────────────────────────────────────────────────────

export async function iniciarFlujoAgendar(
  ctx: FlowContext,
  _tenant: Tenant | null,
  forzarNueva = false,
): Promise<FlowResult> {
  if (!forzarNueva) {
    const tel = ctx.sesionContexto["paciente_telefono_conocido"] as string | undefined;
    const bloqueado = await verificarCitaActiva({
      tenantId: ctx.tenantId,
      telefonoConocido: tel,
      tz: ctx.logCtx.tz,
      ctx: ctx.logCtx,
    });
    if (bloqueado) return { effects: [fxSend(bloqueado)] };
  }

  const profesionales = await profesionalesRepo.listarActivos(ctx.tenantId);
  if (profesionales.length === 0) {
    logWarn(ctx.logCtx, "no hay profesionales activos");
    return { effects: [fxSend({ kind: "text", text: "No hay profesionales disponibles ahora mismo." })] };
  }

  if (profesionales.length === 1) {
    return seleccionarSede({ ctx, profesional: profesionales[0] });
  }

  return {
    effects: [
      fxTransition(ctx.sesionId, "ELIGIENDO_PROFESIONAL", {}),
      fxSend({
        kind: "buttons",
        text: M.eligiendoProfesional(),
        buttons: profesionales.slice(0, 8).map(p => ({
          label: `${p.prefijo} ${p.nombre} ${p.apellido}`,
          data: `profesional:${p.id}`,
        })),
      }),
    ],
  };
}

// ─── Identificar doctor por texto ────────────────────────────────────

export async function handleIdentificarDoctor(
  ctx: FlowContext,
  texto: string,
): Promise<FlowResult | null> {
  return identificarDoctor({ ctx, texto });
}

// ─── Buscar profesional (llamado desde LLM) ───────────────────────────

export async function buscarProfesional(
  ctx: FlowContext,
  tenant: Tenant | null,
  nombreQuery: string,
): Promise<FlowResult> {
  let matches: Array<{ id: string; prefijo: string; nombre: string; apellido: string }>;
  try {
    matches = await profesionalesRepo.buscarPorNombre(ctx.tenantId, nombreQuery, 10);
  } catch (err) {
    logWarn(ctx.logCtx, "búsqueda de profesional falló, fallback a flujo normal", { err: String(err) });
    return iniciarFlujoAgendar(ctx, tenant, false);
  }

  if (matches.length === 0) {
    const todos = await profesionalesRepo.listarActivos(ctx.tenantId);
    if (todos.length === 0) {
      return { effects: [fxSend({ kind: "text", text: "No hay profesionales disponibles ahora mismo." })] };
    }
    if (todos.length === 1) {
      return {
        effects: [
          fxSend({ kind: "text", text: `No encontré a "${nombreQuery}", pero te puedo ayudar con *${todos[0].prefijo} ${todos[0].nombre} ${todos[0].apellido}*.` }),
          ...(await seleccionarSede({ ctx, profesional: todos[0] })).effects,
        ],
      };
    }
    return {
      effects: [
        fxTransition(ctx.sesionId, "ELIGIENDO_PROFESIONAL", {}),
        fxSend({
          kind: "buttons",
          text: `No encontré a "${nombreQuery}". Estos son los profesionales disponibles:`,
          buttons: todos.slice(0, 8).map(p => ({
            label: `${p.prefijo} ${p.nombre} ${p.apellido}`,
            data: `profesional:${p.id}`,
          })),
        }),
      ],
    };
  }

  if (matches.length === 1) {
    const prof = matches[0];
    const tel = ctx.sesionContexto["paciente_telefono_conocido"] as string | undefined;
    const bloqueado = await verificarCitaActiva({
      tenantId: ctx.tenantId,
      telefonoConocido: tel,
      tz: ctx.logCtx.tz,
      ctx: ctx.logCtx,
    });
    if (bloqueado) return { effects: [fxSend(bloqueado)] };

    return {
      effects: [
        fxSend({ kind: "text", text: `¡Perfecto! Te ayudo a agendar con *${prof.prefijo} ${prof.nombre} ${prof.apellido}* 🙌` }),
        ...(await seleccionarSede({ ctx, profesional: prof })).effects,
      ],
    };
  }

  if (matches.length > 8) {
    return {
      effects: [fxSend({
        kind: "text",
        text: `Encontré varios profesionales que coinciden con "${nombreQuery}". ¿Puedes dar un poco más de detalle? (nombre completo o apellido)`,
      })],
    };
  }

  return {
    effects: [
      fxTransition(ctx.sesionId, "ELIGIENDO_PROFESIONAL", {}),
      fxSend({
        kind: "buttons",
        text: `Tengo ${matches.length} profesionales que coinciden con "${nombreQuery}":\n\n${matches.map(p => `• *${p.prefijo} ${p.nombre} ${p.apellido}*`).join("\n")}\n\n¿Cuál prefieres?`,
        buttons: matches.map(p => ({
          label: `${p.prefijo} ${p.nombre} ${p.apellido}`,
          data: `profesional:${p.id}`,
        })),
      }),
    ],
  };
}

// ─── Botón profesional elegido ────────────────────────────────────────

export async function handleProfesionalButton(ctx: FlowContext, profesionalId: string): Promise<FlowResult> {
  const prof = await profesionalesRepo.findById(ctx.tenantId, profesionalId);
  if (!prof) {
    return { effects: [fxSend({ kind: "text", text: "Ese profesional no está disponible." })] };
  }
  return seleccionarSede({ ctx, profesional: prof });
}

// ─── Botón agendar_con ────────────────────────────────────────────────

export async function handleAgendarCon(
  ctx: FlowContext,
  profesionalId: string,
  forzar: boolean,
): Promise<FlowResult> {
  const prof = await profesionalesRepo.findById(ctx.tenantId, profesionalId);
  if (!prof) {
    return { effects: [fxSend({ kind: "text", text: "Ese especialista ya no está disponible. Intenta de nuevo." })] };
  }

  if (!forzar) {
    const tel = ctx.sesionContexto["paciente_telefono_conocido"] as string | undefined;
    const bloqueado = await verificarCitaActiva({
      tenantId: ctx.tenantId,
      telefonoConocido: tel,
      tz: ctx.logCtx.tz,
      ctx: ctx.logCtx,
    });
    if (bloqueado) {
      return {
        effects: [fxSend({
          ...(bloqueado as object),
          buttons: [
            { label: "📅 Agendar adicional", data: `agendar_con:${profesionalId}_force` },
            { label: "🔄 Reagendar la actual",  data: "intent:reagendar" },
            { label: "🏠 Volver", data: "menu:inicio" },
          ],
        } as Parameters<typeof fxSend>[0])],
      };
    }
  }

  return seleccionarSede({ ctx, profesional: prof });
}

// ─── Botón info_doctor ────────────────────────────────────────────────

export async function handleInfoDoctor(ctx: FlowContext, profesionalId: string): Promise<FlowResult> {
  const prof = await profesionalesRepo.findById(ctx.tenantId, profesionalId);
  if (!prof) {
    return { effects: [fxSend({ kind: "text", text: "No encuentro la información de ese especialista." })] };
  }

  const display = `${prof.prefijo} ${prof.nombre} ${prof.apellido}`;
  const partes: string[] = [`*${display}*`];

  if (prof.especialidad) partes.push(`🩺 ${prof.especialidad}`);
  if (prof.anos_experiencia && prof.anos_experiencia > 0) {
    partes.push(`✨ ${prof.anos_experiencia} años de experiencia`);
  }
  if (prof.bio_corta) partes.push(`\n${prof.bio_corta}`);

  try {
    const sedes = await profesionalesRepo.listarSedesPorProfesional(ctx.tenantId, prof.id);
    if (sedes.length > 0) {
      partes.push("\n*📍 Sedes donde atiende:*");
      for (const s of sedes) {
        let linea = `• ${s.sede.nombre}`;
        if (s.sede.ciudad) linea += ` (${s.sede.ciudad})`;
        if (s.sede.direccion) linea += `\n   ${s.sede.direccion}`;
        if (s.sede.telefono) {
          const ext = s.profesionalSede.extension ? ` Ext. ${s.profesionalSede.extension}` : "";
          linea += `\n   ☎️ ${s.sede.telefono}${ext}`;
        }
        partes.push(linea);
      }
    }
  } catch (err) {
    logWarn(ctx.logCtx, "info_doctor: no pude listar sedes", { err: String(err) });
  }

  return {
    effects: [fxSend({
      kind: "buttons",
      text: partes.join("\n"),
      buttons: [
        { label: "📅 Agendar cita", data: `agendar_con:${prof.id}` },
        { label: "🔍 Buscar otro",   data: "buscar_otro" },
      ],
    })],
  };
}

// ─── buscar_otro ──────────────────────────────────────────────────────

export async function handleBuscarOtro(
  _ctx: FlowContext,
  tenant: Tenant | null,
): Promise<FlowResult> {
  const asistente = nombreAsistenteDe(tenant);
  return {
    effects: [
      fxSend({
        kind: "text",
        text: `Dale 👍 Dime el *nombre, apellido o teléfono* del especialista que buscas. (Soy ${asistente} de CitasMed.)`,
      }),
    ],
  };
}

// ─── Re-exportar handlers de steps individuales ───────────────────────

export {
  seleccionarServicio,
  seleccionarServicioButton,
  seleccionarFecha,
  seleccionarSlot,
  recibirNombre,
  recibirTelefono,
  seleccionarTipoPago,
  confirmarCita,
};
