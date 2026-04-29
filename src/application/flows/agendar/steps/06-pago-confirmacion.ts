// src/application/flows/agendar/steps/06-pago-confirmacion.ts
import { agendarCita, listarHorariosLibres } from "../../../use-cases/index.js";
import { validarContextoConfirmacion } from "../../../../domain/validators/confirmacion.js";
import { formatFechaHora, formatHoraCorta, proximosDiasHabiles } from "../../../../domain/datetime.js";
import { DomainError } from "../../../../domain/errors.js";
import { sessionManager } from "../../../session-manager.js";
import * as M from "../../../messages.js";
import type { FlowContext, FlowResult } from "../../../types.js";
import { logInfo, logWarn, logError } from "../../../types.js";
import { fxSend, fxTransition, fxReset } from "../../../effects/runner.js";
import { transicionValida } from "../../../dispatcher/transitions.js";

const TIPOS_PAGO_VALIDOS = ["efectivo", "tarjeta", "transferencia"];

// ─── Tipo de pago ─────────────────────────────────────────────────────

export async function seleccionarTipoPago(ctx: FlowContext, tipo: string): Promise<FlowResult> {
  if (!TIPOS_PAGO_VALIDOS.includes(tipo)) {
    return { effects: [fxSend({ kind: "text", text: "Esa forma de pago no está disponible aún." })] };
  }

  if (!transicionValida(ctx.sesionEstado, "CONFIRMANDO")) {
    logWarn(ctx.logCtx, `transición inválida ${ctx.sesionEstado} → CONFIRMANDO`);
    return { effects: [fxReset(ctx.sesionId, true), fxSend({ kind: "text", text: "Volvamos al menú." })] };
  }

  // Necesitamos leer el contexto actualizado después de la transición para validar.
  // Hacemos la transición directamente aquí porque es el único paso que necesita
  // leer el contexto post-transición antes de enviar el mensaje.
  const sesionActualizada = await sessionManager.transitionTo(
    ctx.sesionId,
    "CONFIRMANDO",
    { tipo_pago: tipo },
  );

  const ctxValidado = validarContextoConfirmacion(sesionActualizada.contexto);
  if (!ctxValidado) {
    logError(ctx.logCtx, "contexto incompleto para confirmación", sesionActualizada.contexto);
    return {
      effects: [
        fxReset(ctx.sesionId, false),
        fxSend({
          kind: "buttons",
          text: "Faltan datos para confirmar la cita. Vamos a empezar de nuevo.",
          buttons: M.botonVolverMenu,
        }),
      ],
    };
  }

  const fechaHora = formatFechaHora(ctxValidado.inicia_en, ctx.logCtx.tz);
  return {
    effects: [fxSend({
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
    })],
  };
}

// ─── Confirmar cita ───────────────────────────────────────────────────

export async function confirmarCita(
  ctx: FlowContext,
  tenantId: string,
  valor: string,
): Promise<FlowResult> {
  if (valor !== "si") {
    return {
      effects: [
        fxReset(ctx.sesionId, true),
        fxSend({ kind: "text", text: M.flujoCancelado() }),
        // El orchestrator añadirá el menuPrincipal
      ],
    };
  }

  // Recargar sesión fresca para evitar races
  const sesionFresca = await sessionManager.loadFresh(ctx.sesionId);
  if (!sesionFresca) {
    logError(ctx.logCtx, "sesión desapareció antes de confirmar", null);
    return { effects: [fxSend({ kind: "text", text: M.errorTecnico() })] };
  }

  const ctxValidado = validarContextoConfirmacion(sesionFresca.contexto);
  if (!ctxValidado) {
    logError(ctx.logCtx, "contexto incompleto en confirmar", sesionFresca.contexto);
    return {
      effects: [
        fxReset(ctx.sesionId, false),
        fxSend({ kind: "text", text: "Faltan datos. Empecemos de nuevo. Usa /start." }),
      ],
    };
  }

  // Re-validar que el slot siga libre
  try {
    const fechaISO = ctxValidado.inicia_en.slice(0, 10);
    const slotsLibres = await listarHorariosLibres({
      profesionalSedeId: ctxValidado.profesional_sede_id,
      fecha: fechaISO,
    });
    const slotSigueLibre = slotsLibres.some(
      s => s.iniciaEn === ctxValidado.inicia_en && s.cuposLibres > 0,
    );

    if (!slotSigueLibre) {
      logWarn(ctx.logCtx, "slot ya no disponible al confirmar, ofreciendo otra hora");
      await sessionManager.transitionTo(ctx.sesionId, "ELIGIENDO_HORA", {});

      if (slotsLibres.length === 0) {
        return {
          effects: [fxSend({
            kind: "buttons",
            text: "Uy, ese horario ya lo tomaron y no me quedan más libres ese día. ¿Otro día?",
            buttons: proximosDiasHabiles(5, ctx.logCtx.tz).map(d => ({ label: d.label, data: `fecha:${d.iso}` })),
          })],
        };
      }

      return {
        effects: [fxSend({
          kind: "buttons",
          text: "Uy, ese horario lo tomaron mientras decidías 😕 Estos están libres todavía:",
          buttons: slotsLibres.slice(0, 8).map(s => ({
            label: formatHoraCorta(s.iniciaEn, ctx.logCtx.tz),
            data: `slot:${s.iniciaEn}`,
          })),
        })],
      };
    }
  } catch (err) {
    logWarn(ctx.logCtx, "re-validación de slot falló, continuamos", { err: String(err) });
  }

  // Agendar
  try {
    const result = await agendarCita({
      tenantId,
      profesionalSedeId: ctxValidado.profesional_sede_id,
      servicioId: ctxValidado.servicio_id,
      iniciaEn: ctxValidado.inicia_en,
      canalOrigen: "telegram",
      pacienteTelefono: ctxValidado.paciente_telefono,
      pacienteNombre: ctxValidado.paciente_nombre,
      pacienteApellido: ctxValidado.paciente_apellido,
      tipoPago: ctxValidado.tipo_pago as "efectivo" | "tarjeta" | "transferencia",
    });

    logInfo(ctx.logCtx, `cita creada: ${result.codigo}`);

    return {
      effects: [
        fxReset(ctx.sesionId, false),
        fxTransition(ctx.sesionId, "IDLE", {
          paciente_telefono_conocido: ctxValidado.paciente_telefono,
          paciente_nombre_conocido: ctxValidado.paciente_nombre,
        }),
        fxSend({ kind: "text", text: M.citaConfirmada(result.codigo) }),
      ],
    };

  } catch (err) {
    if (err instanceof DomainError) {
      logWarn(ctx.logCtx, `dominio rechazó agendar: ${err.code}`, { msg: err.message });
      return {
        effects: [
          fxReset(ctx.sesionId, true),
          fxSend({ kind: "buttons", text: M.errorAgendar(err.message), buttons: M.botonVolverMenu }),
        ],
      };
    }
    logError(ctx.logCtx, "error inesperado en confirmar", err);
    return {
      effects: [
        fxReset(ctx.sesionId, true),
        fxSend({ kind: "text", text: M.errorTecnico() }),
      ],
    };
  }
}
