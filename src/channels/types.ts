// src/channels/core/types.ts
// Contratos comunes a todos los canales (Telegram, WhatsApp, Instagram, FB, Web).
// El orchestrator habla este lenguaje. Cada adapter traduce hacia/desde su API.

/** Mensaje normalizado entrante desde cualquier canal. */
export interface IncomingMessage {
  /** Tipo de canal de donde vino. */
  channelType: "telegram" | "whatsapp_cloud" | "instagram" | "facebook_msg" | "web_widget";

  /** Identificador del canal conectado en DB (canales_conectados.id). */
  channelId: string;

  /** Tenant resuelto desde el canal. */
  tenantId: string;

  /** ID del contacto en el canal externo (chat_id en Telegram, phone en WA). */
  contactoExterno: string;

  /** Nombre que el canal nos dice (ej. first_name en Telegram). Útil pero no autoritativo. */
  contactoNombre?: string;

  /** Tipo de evento. */
  type: "text" | "button_click" | "command" | "other";

  /** Contenido textual si type=text. */
  text?: string;

  /** Si type=button_click: el callback_data del botón presionado. */
  buttonData?: string;

  /** Si type=command: el comando sin la barra (ej. "start", "cancelar"). */
  command?: string;

  /**
   * Si type=command y el comando trae argumentos (ej. `/start dra-carmen-vargas`),
   * este campo contiene la parte después del comando.
   * Útil para deep-links de Telegram (`t.me/Bot?start=PAYLOAD`) y equivalentes
   * en WhatsApp/Instagram. Caso de uso: el paciente llega con el slug del
   * doctor pre-identificado.
   */
  commandArg?: string;

  /** Identificador único del mensaje en el canal (para evitar reprocesar). */
  externalMessageId?: string;

  /** Payload completo original — útil para debugging. */
  raw?: unknown;
}

/** Mensaje normalizado saliente. El adapter lo traduce a la API del canal. */
export type OutgoingMessage =
  | { kind: "text"; text: string }
  | { kind: "buttons"; text: string; buttons: Array<{ label: string; data: string }> }
  | { kind: "list"; text: string; options: Array<{ label: string; description?: string; data: string }> };

/** Capacidades soportadas por un canal. */
export interface ChannelCapabilities {
  maxButtons: number;             // Telegram: ~10. WhatsApp interactive: 3. WA list: 10.
  supportsLists: boolean;
  supportsImages: boolean;
}

/** Contrato que cada canal debe implementar. */
export interface ChannelAdapter {
  readonly type: IncomingMessage["channelType"];
  readonly capabilities: ChannelCapabilities;

  /** Envía un mensaje al usuario. */
  send(channelId: string, contactoExterno: string, msg: OutgoingMessage): Promise<void>;
}
