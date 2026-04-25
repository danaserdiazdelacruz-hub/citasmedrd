// src/persistence/repositories/profesionales.repo.ts
// Lectura de profesionales, sedes y servicios.
// Solo SELECT — los escrituras pasan por la dashboard / API admin.

import { getDb } from "../db.js";
import { DomainError } from "../../domain/errors.js";

export interface Profesional {
  id: string;
  tenant_id: string;
  prefijo: string;
  nombre: string;
  apellido: string;
  bio_corta: string | null;
  foto_url: string | null;
  anos_experiencia: number | null;
  activo: boolean;
}

export interface Sede {
  id: string;
  tenant_id: string;
  nombre: string;
  direccion: string | null;
  ciudad: string | null;
  telefono: string | null;
  latitud: number | null;
  longitud: number | null;
  timezone: string | null;
  activo: boolean;
}

export interface ProfesionalSede {
  id: string;
  tenant_id: string;
  profesional_id: string;
  sede_id: string;
  slot_min: number;
  cupos_por_slot: number;
  buffer_entre_citas_min: number;
  ventana_cancel_gratis_horas: number;
  max_dias_reserva_adelanto: number;
  activo: boolean;
}

export interface Servicio {
  id: string;
  tenant_id: string;
  profesional_sede_id: string;
  codigo: string;
  nombre: string;
  descripcion_publica: string | null;
  duracion_min: number;
  precio: number;
  moneda: string;
  invisible_para_paciente: boolean;
  orden: number;
  activo: boolean;
}

export interface HorarioAtencion {
  id: string;
  profesional_sede_id: string;
  dia_semana: number;             // 0 dom .. 6 sáb
  hora_inicio: string;            // "HH:MM:SS"
  hora_fin: string;
  tiene_pausa: boolean;
  pausa_inicio: string | null;
  pausa_fin: string | null;
  activo: boolean;
}

class ProfesionalesRepo {
  /** Lista profesionales activos del tenant (para mostrar al paciente). */
  async listarActivos(tenantId: string): Promise<Profesional[]> {
    const db = getDb();
    const { data, error } = await db
      .from("profesionales")
      .select("id, tenant_id, prefijo, nombre, apellido, bio_corta, foto_url, anos_experiencia, activo")
      .eq("tenant_id", tenantId)
      .eq("activo", true)
      .is("deleted_at", null)
      .order("apellido", { ascending: true });

    if (error) throw new DomainError("DB_ERROR", error.message);
    return (data ?? []) as Profesional[];
  }

  async findById(tenantId: string, profesionalId: string): Promise<Profesional | null> {
    const db = getDb();
    const { data, error } = await db
      .from("profesionales")
      .select("id, tenant_id, prefijo, nombre, apellido, bio_corta, foto_url, anos_experiencia, activo")
      .eq("tenant_id", tenantId)
      .eq("id", profesionalId)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw new DomainError("DB_ERROR", error.message);
    return data as Profesional | null;
  }

  /** Sedes donde atiende un profesional. */
  async listarSedesPorProfesional(
    tenantId: string,
    profesionalId: string
  ): Promise<Array<{ profesionalSede: ProfesionalSede; sede: Sede }>> {
    const db = getDb();
    const { data, error } = await db
      .from("profesional_sede")
      .select(`
        id, tenant_id, profesional_id, sede_id, slot_min, cupos_por_slot,
        buffer_entre_citas_min, ventana_cancel_gratis_horas, max_dias_reserva_adelanto, activo,
        sedes!inner (
          id, tenant_id, nombre, direccion, ciudad, telefono, latitud, longitud, timezone, activo
        )
      `)
      .eq("tenant_id", tenantId)
      .eq("profesional_id", profesionalId)
      .eq("activo", true);

    if (error) throw new DomainError("DB_ERROR", error.message);

    type Row = ProfesionalSede & { sedes: Sede };
    return ((data ?? []) as unknown as Row[]).map(r => ({
      profesionalSede: {
        id: r.id, tenant_id: r.tenant_id, profesional_id: r.profesional_id,
        sede_id: r.sede_id, slot_min: r.slot_min, cupos_por_slot: r.cupos_por_slot,
        buffer_entre_citas_min: r.buffer_entre_citas_min,
        ventana_cancel_gratis_horas: r.ventana_cancel_gratis_horas,
        max_dias_reserva_adelanto: r.max_dias_reserva_adelanto,
        activo: r.activo,
      },
      sede: r.sedes,
    }));
  }

  /** Servicios de un profesional_sede (visibles al paciente). */
  async listarServiciosPublicos(profesionalSedeId: string): Promise<Servicio[]> {
    const db = getDb();
    const { data, error } = await db
      .from("servicios")
      .select("*")
      .eq("profesional_sede_id", profesionalSedeId)
      .eq("activo", true)
      .eq("invisible_para_paciente", false)
      .is("deleted_at", null)
      .order("orden", { ascending: true });

    if (error) throw new DomainError("DB_ERROR", error.message);
    return (data ?? []) as Servicio[];
  }

  async findServicioById(servicioId: string): Promise<Servicio | null> {
    const db = getDb();
    const { data, error } = await db
      .from("servicios")
      .select("*")
      .eq("id", servicioId)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw new DomainError("DB_ERROR", error.message);
    return data as Servicio | null;
  }

  async findProfesionalSedeById(id: string): Promise<ProfesionalSede | null> {
    const db = getDb();
    const { data, error } = await db
      .from("profesional_sede")
      .select("*")
      .eq("id", id)
      .eq("activo", true)
      .maybeSingle();

    if (error) throw new DomainError("DB_ERROR", error.message);
    return data as ProfesionalSede | null;
  }

  /** Horarios de atención de un ps (ya filtrados por activo). */
  async listarHorariosAtencion(profesionalSedeId: string): Promise<HorarioAtencion[]> {
    const db = getDb();
    const { data, error } = await db
      .from("horarios_atencion")
      .select("*")
      .eq("profesional_sede_id", profesionalSedeId)
      .eq("activo", true)
      .order("dia_semana", { ascending: true });

    if (error) throw new DomainError("DB_ERROR", error.message);
    return (data ?? []) as HorarioAtencion[];
  }
}

export const profesionalesRepo = new ProfesionalesRepo();
