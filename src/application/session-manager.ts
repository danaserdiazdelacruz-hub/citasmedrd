// src/application/session-manager.ts
// Carga, crea y actualiza sesiones de conversación.
// Wrapper sobre sesionesRepo que añade lógica de "obtener-o-crear" + helpers.

import { sesionesRepo } from "../persistence/repositories/index.js";
import type { SesionConversacion, EstadoSesion } from "../persistence/repositories/index.js";

export interface LoadOrCreateInput {
  tenantId: string;
  canalConectadoId: string;
  contactoExterno: string;
}

export class SessionManager {
  /** Carga sesión activa o crea una nueva en estado IDLE. */
  async loadOrCreate(input: LoadOrCreateInput): Promise<SesionConversacion> {
    const existing = await sesionesRepo.load(input.canalConectadoId, input.contactoExterno);
    if (existing) return existing;

    return sesionesRepo.upsert({
      tenantId: input.tenantId,
      canalConectadoId: input.canalConectadoId,
      contactoExterno: input.contactoExterno,
      estado: "IDLE",
      contexto: {},
    });
  }

  async transitionTo(
    sesionId: string,
    estado: EstadoSesion,
    contextoMerge?: Record<string, unknown>
  ): Promise<void> {
    await sesionesRepo.updateEstado(sesionId, estado, contextoMerge);
  }

  async resetToIdle(sesionId: string): Promise<void> {
    await sesionesRepo.resetToIdle(sesionId);
  }

  async appendUser(sesionId: string, content: string): Promise<void> {
    await sesionesRepo.appendHistorial(sesionId, "user", content);
  }

  async appendAssistant(sesionId: string, content: string): Promise<void> {
    await sesionesRepo.appendHistorial(sesionId, "assistant", content);
  }
}

export const sessionManager = new SessionManager();
