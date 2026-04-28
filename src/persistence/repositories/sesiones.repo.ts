// src/persistence/repositories/sesiones.repo.ts
// CRUD de sesiones_conversacion. Estado del flujo conversacional por contacto.
//
// La sesión es la "memoria" del bot por usuario. Persistida en DB para que
// sobreviva reinicios y escalamiento horizontal.

import { getDb } from "../db.js";
import { DomainError } from "../../domain/errors.js";

export type EstadoSesion =
  | "IDLE"
  | "ELIGIENDO_INTENCION"
  | "ELIGIENDO_PROFESIONAL"
  | "ELIGIENDO_SEDE"
  | "ELIGIENDO_SERVICIO"
  | "ELIGIENDO_HORA"
  | "PIDIENDO_NOMBRE"
  | "PIDIENDO_TELEFONO"
  | "ELIGIENDO_TIPO_PAGO"
  | "ELIGIENDO_ASEGURADORA"
  | "CONFIRMANDO"
  | "CONSULTANDO_CITA"
  | "CANCELANDO_CITA"
  | "REAGENDANDO_CITA";

export interface SesionConversacion {
  id: string;
  tenant_id: string;
  canal_conectado_id: string;
  contacto_externo: string;
  paciente_id: string | null;
  estado: EstadoSesion;
  contexto: Record<string, unknown>;
  historial: Array<{ role: string; content: string; ts: string }>;
  ultimo_mensaje_en: string;
  expira_en: string;
  creado_en: string;
  actualizado_en: string;
}

export interface UpsertSesionInput {
  tenantId: string;
  canalConectadoId: string;
  contactoExterno: string;
  pacienteId?: string | null;
  estado?: EstadoSesion;
  contexto?: Record<string, unknown>;
}

const SESION_TTL_HORAS = 24;

class SesionesRepo {
  /**
   * Carga sesión activa por (canal_conectado_id, contacto_externo).
   * Si la sesión expiró, la considera nula.
   */
  async load(canalConectadoId: string, contactoExterno: string): Promise<SesionConversacion | null> {
    const db = getDb();
    const { data, error } = await db
      .from("sesiones_conversacion")
      .select("*")
      .eq("canal_conectado_id", canalConectadoId)
      .eq("contacto_externo", contactoExterno)
      .maybeSingle();

    if (error) throw new DomainError("DB_ERROR", error.message);
    if (!data) return null;

    // Si expiró, la tratamos como inexistente (el orchestrator creará nueva)
    if (new Date(data.expira_en).getTime() < Date.now()) {
      return null;
    }
    return data as SesionConversacion;
  }

  /**
   * Crea o actualiza sesión por (canal_conectado_id, contacto_externo).
   * Renueva expira_en a +24h en cada upsert.
   */
  async upsert(input: UpsertSesionInput): Promise<SesionConversacion> {
    const db = getDb();
    const ahora = new Date();
    const expira = new Date(ahora.getTime() + SESION_TTL_HORAS * 3600 * 1000);

    const { data, error } = await db
      .from("sesiones_conversacion")
      .upsert(
        {
          tenant_id: input.tenantId,
          canal_conectado_id: input.canalConectadoId,
          contacto_externo: input.contactoExterno,
          paciente_id: input.pacienteId ?? null,
          estado: input.estado ?? "IDLE",
          contexto: input.contexto ?? {},
          ultimo_mensaje_en: ahora.toISOString(),
          expira_en: expira.toISOString(),
        },
        { onConflict: "canal_conectado_id,contacto_externo" }
      )
      .select()
      .single();

    if (error) throw new DomainError("DB_ERROR", error.message);
    return data as SesionConversacion;
  }

  /**
   * Actualiza solo estado y/o contexto de una sesión existente.
   * Renueva expira_en y ultimo_mensaje_en.
   */
  async updateEstado(
    sesionId: string,
    estado: EstadoSesion,
    contextoMerge?: Record<string, unknown>
  ): Promise<void> {
    const db = getDb();
    const ahora = new Date();
    const expira = new Date(ahora.getTime() + SESION_TTL_HORAS * 3600 * 1000);

    // Si vienen cambios de contexto, los mergeamos en DB con jsonb concat
    const updates: Record<string, unknown> = {
      estado,
      ultimo_mensaje_en: ahora.toISOString(),
      expira_en: expira.toISOString(),
    };

    // Para merge profundo de contexto, leer-modificar-escribir
    if (contextoMerge) {
      const { data: actual, error: e1 } = await db
        .from("sesiones_conversacion")
        .select("contexto")
        .eq("id", sesionId)
        .single();
      if (e1) throw new DomainError("DB_ERROR", e1.message);
      updates.contexto = { ...(actual?.contexto ?? {}), ...contextoMerge };
    }

    const { error } = await db
      .from("sesiones_conversacion")
      .update(updates)
      .eq("id", sesionId);

    if (error) throw new DomainError("DB_ERROR", error.message);
  }

  /** Marca sesión como IDLE (después de completar/abortar un flujo). */
  async resetToIdle(sesionId: string): Promise<void> {
    await this.updateEstado(sesionId, "IDLE", {});
    const db = getDb();
    await db
      .from("sesiones_conversacion")
      .update({ contexto: {} })
      .eq("id", sesionId);
  }

  /** Agrega un turno al historial conversacional (rolling window de N mensajes). */
  async appendHistorial(
    sesionId: string,
    role: "user" | "assistant",
    content: string,
    maxTurnos = 20
  ): Promise<void> {
    const db = getDb();
    const { data: actual, error: e1 } = await db
      .from("sesiones_conversacion")
      .select("historial")
      .eq("id", sesionId)
      .single();
    if (e1) throw new DomainError("DB_ERROR", e1.message);

    const historial = Array.isArray(actual?.historial) ? actual.historial : [];
    historial.push({ role, content, ts: new Date().toISOString() });
    const recortado = historial.slice(-maxTurnos);

    const { error } = await db
      .from("sesiones_conversacion")
      .update({ historial: recortado })
      .eq("id", sesionId);

    if (error) throw new DomainError("DB_ERROR", error.message);
  }
}

export const sesionesRepo = new SesionesRepo();
