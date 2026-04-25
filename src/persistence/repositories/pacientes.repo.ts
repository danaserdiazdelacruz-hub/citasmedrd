// src/persistence/repositories/pacientes.repo.ts
// Acceso a tabla pacientes + RPC fn_get_or_create_paciente.
// Idempotente: si el teléfono ya existe, devuelve el paciente sin tocarlo.

import { getDb, rpc } from "../db.js";
import { DomainError } from "../../domain/errors.js";
import type { PacienteResult } from "./types.js";

export interface Paciente {
  id: string;
  tenant_id: string;
  nombre: string;
  apellido: string;
  telefono: string;
  email: string | null;
  documento_identidad: string | null;
  fecha_nacimiento: string | null;
  sexo: string | null;
  etiquetas: unknown[];
  creado_en: string;
}

export interface GetOrCreateInput {
  tenantId: string;
  telefono: string;       // E.164 ya validado
  nombre: string;
  apellido?: string;
}

class PacientesRepo {
  /**
   * Crea o recupera paciente por (tenant_id, telefono).
   * Si existe, devuelve creado=false. Si no, creado=true.
   */
  async getOrCreate(input: GetOrCreateInput): Promise<PacienteResult> {
    const { data, error } = await rpc<PacienteResult>("fn_get_or_create_paciente", {
      p_tenant_id: input.tenantId,
      p_telefono: input.telefono,
      p_nombre: input.nombre,
      p_apellido: input.apellido ?? "",
    });

    if (error) throw new DomainError("DB_ERROR", error.message);
    if (!data || data.length === 0) {
      throw new DomainError("UNKNOWN", "fn_get_or_create_paciente no devolvió filas");
    }
    return data[0];
  }

  /** Lookup directo por id (para casos de uso que ya tienen el id). */
  async findById(tenantId: string, pacienteId: string): Promise<Paciente | null> {
    const db = getDb();
    const { data, error } = await db
      .from("pacientes")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("id", pacienteId)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw new DomainError("DB_ERROR", error.message);
    return data as Paciente | null;
  }

  /** Lookup por teléfono (sin crear). Útil para saber si es paciente nuevo o recurrente. */
  async findByTelefono(tenantId: string, telefono: string): Promise<Paciente | null> {
    const db = getDb();
    const { data, error } = await db
      .from("pacientes")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("telefono", telefono)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw new DomainError("DB_ERROR", error.message);
    return data as Paciente | null;
  }
}

export const pacientesRepo = new PacientesRepo();
