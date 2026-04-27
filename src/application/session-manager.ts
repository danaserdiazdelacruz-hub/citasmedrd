// src/application/session-manager.ts
// Carga, crea y actualiza sesiones de conversación.
//
// CAMBIO CRÍTICO vs versión anterior:
//   - transitionTo ahora retorna la sesión ACTUALIZADA, no void.
//   - Esto elimina el bug de "stale context" donde el orchestrator leía
//     contexto viejo después de mutar.
//   - Las funciones que mutan + leen DEBEN usar la sesión retornada,
//     no la cacheada.

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

  /**
   * Cambia el estado de la sesión y mergea el contexto.
   * RETORNA la sesión actualizada — siempre úsala en lugar de la copia anterior.
   */
  async transitionTo(
    sesionId: string,
    estado: EstadoSesion,
    contextoMerge?: Record<string, unknown>
  ): Promise<SesionConversacion> {
    await sesionesRepo.updateEstado(sesionId, estado, contextoMerge);
    // Recargar para devolver el estado real persistido
    const fresh = await this.loadFresh(sesionId);
    if (!fresh) {
      throw new Error(`transitionTo: sesión ${sesionId} desapareció después de update`);
    }
    return fresh;
  }

  /** Recarga la sesión desde DB por ID (no por canal/contacto). */
  async loadFresh(sesionId: string): Promise<SesionConversacion | null> {
    const { getDb } = await import("../persistence/db.js");
    const db = getDb();
    const { data, error } = await db
      .from("sesiones_conversacion")
      .select("*")
      .eq("id", sesionId)
      .maybeSingle();

    if (error) throw new Error(`loadFresh DB: ${error.message}`);
    return (data as SesionConversacion | null);
  }

  async resetToIdle(sesionId: string): Promise<SesionConversacion> {
    await sesionesRepo.resetToIdle(sesionId);
    const fresh = await this.loadFresh(sesionId);
    if (!fresh) throw new Error(`resetToIdle: sesión ${sesionId} desapareció`);
    return fresh;
  }

  async appendUser(sesionId: string, content: string): Promise<void> {
    await sesionesRepo.appendHistorial(sesionId, "user", content);
  }

  async appendAssistant(sesionId: string, content: string): Promise<void> {
    await sesionesRepo.appendHistorial(sesionId, "assistant", content);
  }
}

export const sessionManager = new SessionManager();
