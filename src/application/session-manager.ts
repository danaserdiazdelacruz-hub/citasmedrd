// src/application/session-manager.ts
// Carga, crea y actualiza sesiones de conversación.
//
// CAMBIO v3:
//   - resetToIdle ya no lee-modifica-escribe en la app. Pasa la lista de
//     campos a preservar al repo, que hace todo en SQL atómico.
//   - transitionTo retorna la sesión ACTUALIZADA (anti stale-context).

import { sesionesRepo } from "../persistence/repositories/index.js";
import type { SesionConversacion, EstadoSesion } from "../persistence/repositories/index.js";

export interface LoadOrCreateInput {
  tenantId: string;
  canalConectadoId: string;
  contactoExterno: string;
}

/** Campos del contexto que sobreviven al reset (memoria a largo plazo del paciente). */
const KEYS_MEMORIA_LARGA = [
  "paciente_telefono_conocido",
  "paciente_nombre_conocido",
];

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
    const fresh = await this.loadFresh(sesionId);
    if (!fresh) {
      throw new Error(`transitionTo: sesión ${sesionId} desapareció después de update`);
    }
    return fresh;
  }

  /** Recarga la sesión desde DB por ID. */
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

  /**
   * Resetea estado a IDLE y limpia contexto.
   * Si preserveMemoria=true, conserva paciente_telefono_conocido y paciente_nombre_conocido.
   */
  async resetToIdle(sesionId: string, preserveMemoria = true): Promise<SesionConversacion> {
    const preservar = preserveMemoria ? KEYS_MEMORIA_LARGA : [];
    await sesionesRepo.resetToIdle(sesionId, preservar);
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
