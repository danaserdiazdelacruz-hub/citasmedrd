// src/application/dispatcher/index.ts
// Dispatcher del FSM. PURO: no ejecuta nada, solo decide.
// Recibe (estado, evento) y devuelve HandlerConfig.
// Sin imports de sessionManager, repos, ni LLM.

import type { EstadoSesion } from "../../persistence/repositories/index.js";
import type { EventoInterno, HandlerConfig } from "../types.js";
import {
  quiereCancelar,
  quiereGestionarCita,
  esCortesia,
  esSaludo,
  pareceBusquedaDeDoctor,
} from "./guards.js";

// ─── Estados que aceptan texto libre como input válido ────────────────
// En estos estados el texto no es "cambio de opinión", es parte del flujo.

const ESTADOS_QUE_ESPERAN_TEXTO = new Set<EstadoSesion>([
  "PIDIENDO_NOMBRE",
  "PIDIENDO_TELEFONO",
]);

export function dispatch(
  estado: EstadoSesion,
  evento: EventoInterno,
): HandlerConfig {

  // ─── Comandos ─────────────────────────────────────────────────────

  if (evento.tipo === "command") {
    const cmd = evento.command ?? "";
    if (cmd === "start" || cmd === "menu") {
      return {
        kind: "command:start",
        payload: { slug: evento.commandArg, estadoActual: estado },
      };
    }
    if (cmd === "cancelar" || cmd === "salir") {
      return { kind: "command:cancelar" };
    }
    // Comando no reconocido → tratar como texto al LLM
    return { kind: "intent:llm" };
  }

  // ─── Botones ──────────────────────────────────────────────────────

  if (evento.tipo === "button") {
    const tipo  = evento.buttonTipo ?? "";
    const valor = evento.buttonValor ?? "";
    return dispatchButton(tipo, valor, estado);
  }

  // ─── Texto libre ──────────────────────────────────────────────────

  const texto = evento.text ?? "";

  // Cancelación universal (fuera de IDLE y fuera de estados de input)
  if (quiereCancelar(texto) && estado !== "IDLE" && !ESTADOS_QUE_ESPERAN_TEXTO.has(estado)) {
    return { kind: "global:cancelar_flujo" };
  }

  // Estados que esperan input específico del usuario
  if (estado === "PIDIENDO_NOMBRE") {
    return { kind: "flow:agendar:slot", payload: { accion: "nombre", texto } };
    // Nota: reutilizamos el kind del paso, el handler decide qué hacer con `accion`
  }
  if (estado === "PIDIENDO_TELEFONO") {
    return { kind: "flow:agendar:slot", payload: { accion: "telefono", texto } };
  }

  // ─── IDLE + texto libre ───────────────────────────────────────────

  if (estado === "IDLE") {
    if (esCortesia(texto)) return { kind: "global:cortesia" };
    if (esSaludo(texto))   return { kind: "global:saludo" };

    // Código de cita → consultar directamente
    if (/^CITA-[A-Z0-9]{4,8}$/i.test(texto.trim())) {
      return { kind: "flow:consultar:por_codigo", payload: { codigo: texto.trim() } };
    }

    if (quiereGestionarCita(texto, "cancelar")) {
      return { kind: "flow:cancelar:mostrar", payload: { fuenteIntencion: "guard" } };
    }
    if (quiereGestionarCita(texto, "consultar")) {
      return { kind: "flow:consultar:mostrar", payload: { fuenteIntencion: "guard" } };
    }

    if (pareceBusquedaDeDoctor(texto)) {
      return { kind: "flow:agendar:identificar", payload: { texto } };
    }
    return { kind: "intent:llm", payload: { texto } };
  }

  // ─── Texto libre en estado que esperaba botón ─────────────────────
  // El usuario cambió de opinión. Soft-reset y procesar con LLM.

  return {
    kind: "global:soft_reset_then_llm",
    payload: { texto, estadoAnterior: estado },
  };
}


// ─── Router de botones ────────────────────────────────────────────────

function dispatchButton(
  tipo: string,
  valor: string,
  _estado: EstadoSesion,
): HandlerConfig {
  switch (tipo) {
    case "intent":
      return dispatchIntent(valor);

    case "profesional":
      return { kind: "flow:agendar:profesional_button", payload: { profesionalId: valor } };

    case "agendar_con": {
      // agendar_con:<id>_force → forzar nueva cita aunque haya activa
      const [id, flag] = valor.split("_force");
      return {
        kind: "flow:agendar:agendar_con",
        payload: { profesionalId: id, forzar: flag !== undefined },
      };
    }

    case "info_doctor":
      return { kind: "flow:agendar:info_doctor", payload: { profesionalId: valor } };

    case "buscar_otro":
      return { kind: "flow:agendar:buscar_otro" };

    case "sede":
      return { kind: "flow:agendar:sede", payload: { psId: valor } };

    case "servicio":
      return { kind: "flow:agendar:servicio", payload: { servicioId: valor } };

    case "fecha":
      return { kind: "flow:agendar:fecha", payload: { fecha: valor } };

    case "slot":
      return { kind: "flow:agendar:slot", payload: { iniciaEn: valor } };

    case "tipopago":
      return { kind: "flow:agendar:tipo_pago", payload: { tipo: valor } };

    case "confirmar":
      return { kind: "flow:agendar:confirmar", payload: { valor } };

    case "cancelar_cita":
      return { kind: "flow:cancelar:ejecutar", payload: { citaId: valor } };

    case "menu":
      return { kind: "global:menu" };

    case "reset":
      return {
        kind: valor === "si" ? "global:reset_execute" : "global:reset_confirm",
      };

    default:
      return { kind: "intent:llm" };
  }
}


// ─── Router de intenciones ────────────────────────────────────────────

function dispatchIntent(valor: string): HandlerConfig {
  switch (valor) {
    case "agendar":
    case "horarios":
      return { kind: "flow:agendar:iniciar", payload: { forzarNueva: false } };

    case "agendar_otra":
      return { kind: "flow:agendar:iniciar", payload: { forzarNueva: true } };

    case "consultar":
      return { kind: "flow:consultar:mostrar", payload: { fuenteIntencion: "button" } };

    case "cancelar":
      return { kind: "flow:cancelar:mostrar", payload: { fuenteIntencion: "button" } };

    case "reagendar":
      return { kind: "flow:reagendar:iniciar" };

    default:
      return { kind: "intent:llm" };
  }
}
