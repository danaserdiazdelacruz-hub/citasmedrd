// src/persistence/repositories/sesiones.repo.ts
// CRUD de sesiones_conversacion. Estado del flujo conversacional por contacto.
//
// La sesión es la "memoria" del bot por usuario. Persistida en DB para que
// sobreviva reinicios y escalamiento horizontal.
//
// CAMBIO v3: las operaciones de merge (contexto, historial) ahora son atómicas
// en la DB. Antes había read-modify-write que perdía datos en concurrencia.
// Ahora usamos jsonb concat (`||`) y array append directo en SQL via RPC.

import { getDb, rpc } from "../db.js";
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
const HISTORIAL_MAX_TURNOS = 20;

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
   * Actualiza estado y mergea contexto ATÓMICAMENTE en la DB.
   * Sin race conditions: una sola UPDATE con jsonb concat.
   *
   * Implementado vía fn_sesion_update (ver migración 005). Si la función no
   * existe (DB vieja), cae al método read-modify-write con warning.
   */
  async updateEstado(
    sesionId: string,
    estado: EstadoSesion,
    contextoMerge?: Record<string, unknown>
  ): Promise<void> {
    const { error: rpcErr } = await rpc("fn_sesion_update", {
      p_sesion_id: sesionId,
      p_estado: estado,
      p_contexto_merge: contextoMerge ?? {},
      p_ttl_horas: SESION_TTL_HORAS,
    });

    if (!rpcErr) return;

    const isMissingFn = /function .* does not exist/i.test(rpcErr.message);
    if (!isMissingFn) {
      throw new DomainError("DB_ERROR", rpcErr.message);
    }
    console.warn(
      `[sesiones] fn_sesion_update no existe en la DB, usando fallback. ` +
      `Aplica migración 005_sesion_atomic.sql para eliminar race conditions.`
    );
    await this.updateEstadoLegacy(sesionId, estado, contextoMerge);
  }

  /** Fallback legacy: read-modify-write. */
  private async updateEstadoLegacy(
    sesionId: string,
    estado: EstadoSesion,
    contextoMerge?: Record<string, unknown>
  ): Promise<void> {
    const db = getDb();
    const ahora = new Date();
    const expira = new Date(ahora.getTime() + SESION_TTL_HORAS * 3600 * 1000);

    const updates: Record<string, unknown> = {
      estado,
      ultimo_mensaje_en: ahora.toISOString(),
      expira_en: expira.toISOString(),
    };

    if (contextoMerge && Object.keys(contextoMerge).length > 0) {
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

  /**
   * Marca sesión como IDLE limpiando contexto. Atómico.
   * Si `preservar` viene, conserva esos campos del contexto anterior.
   */
  async resetToIdle(sesionId: string, preservar?: string[]): Promise<void> {
    const { error: rpcErr } = await rpc("fn_sesion_reset", {
      p_sesion_id: sesionId,
      p_preservar_keys: preservar ?? [],
      p_ttl_horas: SESION_TTL_HORAS,
    });
    if (!rpcErr) return;

    const isMissingFn = /function .* does not exist/i.test(rpcErr.message);
    if (!isMissingFn) throw new DomainError("DB_ERROR", rpcErr.message);

    // Fallback legacy
    const db = getDb();
    const memoria: Record<string, unknown> = {};
    if (preservar && preservar.length > 0) {
      const { data, error } = await db
        .from("sesiones_conversacion")
        .select("contexto")
        .eq("id", sesionId)
        .single();
      if (error) throw new DomainError("DB_ERROR", error.message);
      const ctx = (data?.contexto ?? {}) as Record<string, unknown>;
      for (const k of preservar) {
        if (ctx[k] !== undefined) memoria[k] = ctx[k];
      }
    }
    const ahora = new Date();
    const { error } = await db
      .from("sesiones_conversacion")
      .update({
        estado: "IDLE",
        contexto: memoria,
        ultimo_mensaje_en: ahora.toISOString(),
      })
      .eq("id", sesionId);
    if (error) throw new DomainError("DB_ERROR", error.message);
  }

  /**
   * Agrega un turno al historial atómicamente (jsonb append + slice).
   */
  async appendHistorial(
    sesionId: string,
    role: "user" | "assistant",
    content: string,
    maxTurnos = HISTORIAL_MAX_TURNOS
  ): Promise<void> {
    const turno = { role, content, ts: new Date().toISOString() };
    const { error: rpcErr } = await rpc("fn_sesion_append_historial", {
      p_sesion_id: sesionId,
      p_turno: turno,
      p_max_turnos: maxTurnos,
    });
    if (!rpcErr) return;

    const isMissingFn = /function .* does not exist/i.test(rpcErr.message);
    if (!isMissingFn) throw new DomainError("DB_ERROR", rpcErr.message);

    // Fallback legacy
    const db = getDb();
    const { data: actual, error: e1 } = await db
      .from("sesiones_conversacion")
      .select("historial")
      .eq("id", sesionId)
      .single();
    if (e1) throw new DomainError("DB_ERROR", e1.message);

    const historial = Array.isArray(actual?.historial) ? actual.historial : [];
    historial.push(turno);
    const recortado = historial.slice(-maxTurnos);

    const { error } = await db
      .from("sesiones_conversacion")
      .update({ historial: recortado })
      .eq("id", sesionId);

    if (error) throw new DomainError("DB_ERROR", error.message);
  }
}

export const sesionesRepo = new SesionesRepo();
