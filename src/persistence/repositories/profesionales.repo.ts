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
  /** Especialidad médica (ej: "Ginecología Oncológica"). Opcional. */
  especialidad: string | null;
  /** WhatsApp directo del doctor (NO el de la sede). Opcional. */
  telefono: string | null;
  /** Configuración por doctor: { faq, asistente, ... }. Default {}. Migración 007. */
  configuracion: Record<string, unknown>;
  /** Slug único para deep-link `/start <slug>`. Se genera en onboarding. Migración 008. */
  slug: string | null;
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
  /** Extensión telefónica del doctor en esa sede (ej: "1012"). Opcional. */
  extension: string | null;
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
      .select("id, tenant_id, prefijo, nombre, apellido, bio_corta, foto_url, anos_experiencia, especialidad, telefono, configuracion, slug, activo")
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
      .select("id, tenant_id, prefijo, nombre, apellido, bio_corta, foto_url, anos_experiencia, especialidad, telefono, configuracion, slug, activo")
      .eq("tenant_id", tenantId)
      .eq("id", profesionalId)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw new DomainError("DB_ERROR", error.message);
    return data as Profesional | null;
  }

  /**
   * Busca profesional por slug (deep-link).
   * Filtra por tenant para evitar colisiones cross-tenant.
   */
  async findBySlug(tenantId: string, slug: string): Promise<Profesional | null> {
    const db = getDb();
    const { data, error } = await db
      .from("profesionales")
      .select("id, tenant_id, prefijo, nombre, apellido, bio_corta, foto_url, anos_experiencia, especialidad, telefono, configuracion, slug, activo")
      .eq("tenant_id", tenantId)
      .eq("slug", slug.toLowerCase())
      .eq("activo", true)
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
        buffer_entre_citas_min, ventana_cancel_gratis_horas, max_dias_reserva_adelanto,
        extension, activo,
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
        extension: r.extension,
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

  /**
   * Aseguradoras que un profesional acepta.
   * Devuelve solo las relaciones con `acepta = true`, ordenadas por nombre.
   * Si la tabla `profesional_aseguradora` no existe (DB vieja) o falla, devuelve [].
   */
  async listarAseguradorasDeProfesional(
    profesionalId: string,
  ): Promise<Array<{ nombre: string; codigo: string }>> {
    const db = getDb();
    const { data, error } = await db
      .from("profesional_aseguradora")
      .select(`
        acepta,
        aseguradoras!inner ( nombre, codigo, activo )
      `)
      .eq("profesional_id", profesionalId)
      .eq("acepta", true);

    if (error) {
      // No tirar — si la tabla no existe en una DB vieja, devolvemos vacío
      console.warn(`[profesionales] listarAseguradorasDeProfesional falló: ${error.message}`);
      return [];
    }

    type Row = { acepta: boolean; aseguradoras: { nombre: string; codigo: string; activo: boolean } };
    return ((data ?? []) as unknown as Row[])
      .filter(r => r.aseguradoras.activo)
      .map(r => ({ nombre: r.aseguradoras.nombre, codigo: r.aseguradoras.codigo }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  /**
   * Busca profesionales por nombre/apellido del query del paciente.
   * Casos típicos:
   *   - "Hairol Pérez"  → match en nombre Y apellido
   *   - "Pérez"          → match solo apellido
   *   - "doctora maría" → match en nombre
   *
   * Reglas:
   *   - Solo profesionales activos del tenant.
   *   - ILIKE (case-insensitive). El usuario puede escribir con/sin acento;
   *     Postgres ILIKE NO normaliza acentos por sí mismo, así que para "perez"
   *     vs "Pérez" usamos `unaccent` si está disponible. Si no, hacemos
   *     fallback a `ILIKE` simple (puede perder algún match con acentos).
   *   - Devuelve hasta `limit` resultados, ordenados por apellido.
   *   - Query corto (<2 chars) devuelve [] para evitar matches espurios.
   *
   * Esta función NO modifica datos. Solo SELECT.
   */
  async buscarPorNombre(
    tenantId: string,
    query: string,
    limit = 10,
  ): Promise<Profesional[]> {
    const q = (query ?? "").trim();
    if (q.length < 2) return [];

    const db = getDb();

    // Tokenizamos: cada palabra del query se busca por separado en nombre+apellido.
    // Esto permite "Hairol Pérez" → match donde nombre ILIKE %hairol% AND apellido ILIKE %pérez%
    // o también nombre ILIKE %pérez% (cubre orden invertido del usuario).
    const tokens = q.split(/\s+/).filter(t => t.length >= 2).slice(0, 3);
    if (tokens.length === 0) return [];

    // Construimos un OR amplio: cualquier token puede aparecer en nombre o apellido.
    // El ranking lo hace JS después (matches con más tokens van primero).
    const orClauses: string[] = [];
    for (const t of tokens) {
      const escaped = t.replace(/[%_,]/g, ""); // chars que rompen ilike
      if (escaped.length === 0) continue;
      orClauses.push(`nombre.ilike.%${escaped}%`);
      orClauses.push(`apellido.ilike.%${escaped}%`);
    }
    if (orClauses.length === 0) return [];

    const { data, error } = await db
      .from("profesionales")
      .select("id, tenant_id, prefijo, nombre, apellido, bio_corta, foto_url, anos_experiencia, especialidad, telefono, configuracion, slug, activo")
      .eq("tenant_id", tenantId)
      .eq("activo", true)
      .is("deleted_at", null)
      .or(orClauses.join(","))
      .order("apellido", { ascending: true })
      .limit(limit * 2); // pedimos un poco más para ranking en JS

    if (error) throw new DomainError("DB_ERROR", error.message);

    const filas = (data ?? []) as Profesional[];

    // Ranking simple: cuántos tokens del query aparecen en el "nombre apellido" de la fila.
    const norm = (s: string) =>
      s.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, ""); // quita acentos en JS para ranking

    const tokensNorm = tokens.map(norm);
    const ranked = filas
      .map(p => {
        const haystack = norm(`${p.nombre} ${p.apellido}`);
        const score = tokensNorm.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
        const exactWordBoost = tokensNorm.every(t =>
          haystack.split(/\s+/).some(w => w === t)
        ) ? 1 : 0;
        return { p, score: score + exactWordBoost };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.p);

    return ranked;
  }

  /**
   * Busca profesionales por su WhatsApp (columna `telefono`) o por extensión
   * de cualquiera de sus sedes.
   *
   * - Si `query` matchea exactamente un teléfono normalizado E.164 → match en `profesionales.telefono`.
   * - Si `query` es un string corto (probablemente una extensión) → match en `profesional_sede.extension`.
   *
   * Devuelve los profesionales activos del tenant que matcheen.
   */
  async buscarPorTelefonoOExtension(
    tenantId: string,
    query: string,
  ): Promise<Profesional[]> {
    const db = getDb();
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const matches = new Map<string, Profesional>();

    // 1) Match exacto por columna `telefono` (WhatsApp del doctor)
    {
      const { data, error } = await db
        .from("profesionales")
        .select("id, tenant_id, prefijo, nombre, apellido, bio_corta, foto_url, anos_experiencia, especialidad, telefono, configuracion, slug, activo")
        .eq("tenant_id", tenantId)
        .eq("activo", true)
        .is("deleted_at", null)
        .eq("telefono", trimmed);

      if (error) throw new DomainError("DB_ERROR", error.message);
      for (const p of (data ?? []) as Profesional[]) {
        matches.set(p.id, p);
      }
    }

    // 2) Si parece extensión (todo dígitos, hasta 6 caracteres), buscar en profesional_sede
    if (/^\d{1,6}$/.test(trimmed)) {
      const { data, error } = await db
        .from("profesional_sede")
        .select(`
          profesional_id,
          profesionales!inner (
            id, tenant_id, prefijo, nombre, apellido, bio_corta, foto_url,
            anos_experiencia, especialidad, telefono, activo, deleted_at
          )
        `)
        .eq("tenant_id", tenantId)
        .eq("extension", trimmed)
        .eq("activo", true);

      if (error) throw new DomainError("DB_ERROR", error.message);
      type Row = { profesional_id: string; profesionales: Profesional & { deleted_at: string | null } };
      for (const r of (data ?? []) as unknown as Row[]) {
        const p = r.profesionales;
        if (p.activo && p.deleted_at === null) {
          matches.set(p.id, p);
        }
      }
    }

    return Array.from(matches.values()).sort((a, b) => a.apellido.localeCompare(b.apellido));
  }
}

export const profesionalesRepo = new ProfesionalesRepo();
