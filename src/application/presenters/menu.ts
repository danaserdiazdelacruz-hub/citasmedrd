// src/application/presenters/menu.ts
// Presenter del menú principal. PURO: recibe datos ya resueltos, nunca hace queries.

import * as M from "../messages.js";
import type { OutgoingMessage } from "../../channels/core/types.js";

export interface MenuProps {
  nombreAsistente: string;
  citaActiva?: {
    nombreClinica: string;
    fechaHora: string;
    servicioNombre: string;
  };
}

export function renderMenu(props: MenuProps): OutgoingMessage {
  if (props.citaActiva) {
    return {
      kind: "buttons",
      text: M.saludoConCitaPendiente(
        props.citaActiva.nombreClinica,
        props.citaActiva.fechaHora,
        props.citaActiva.servicioNombre,
        props.nombreAsistente,
      ),
      buttons: M.opcionesMenuConCitaPendiente,
    };
  }

  return {
    kind: "text",
    text: M.saludoCitasMed(props.nombreAsistente),
  };
}
