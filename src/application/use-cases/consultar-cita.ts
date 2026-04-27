// src/application/use-cases/consultar-cita.ts
// Lee una cita por código (CITA-XXXXXX) o por id.
// Útil para que el bot/dashboard muestre detalles.

import { getDb } from "../../persistence/db.js";
import { DomainError } from "../../domain/errors.js";

export interface CitaDetalle {
  id: string;
  codigo: string;
  estado: string;
  iniciaEn: string;
  duracionMin: number;
  precioCobrado: number | null;
  moneda: string;
  motivoVisita: string | null;
  pacienteNombre: string;
  pacienteApellido: string;
  pacienteTelefono: string;
  profesionalNombre: string;
  profesionalApellido: string;
  sedeNombre: string;
  servicioNombre: string;
}

export async function consultarCitaPorCodigo(
  tenantId: string,
  codigo: string
): Promise<CitaDetalle | null> {
  const db = getDb();
  const { data, error } = await db
    .from("citas")
    .select(`
      id, codigo, estado, inicia_en, duracion_min, precio_cobrado, moneda, motivo_visita,
      pacientes!inner ( nombre, apellido, telefono ),
      profesional_sede!inner (
        profesionales!inner ( nombre, apellido ),
        sedes!inner ( nombre )
      ),
      servicios!inner ( nombre )
    `)
    .eq("tenant_id", tenantId)
    .eq("codigo", codigo.toUpperCase())
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw new DomainError("DB_ERROR", error.message);
  if (!data) return null;

  // El cast tipa lo que sabemos que devuelve esa estructura anidada
  const row = data as unknown as {
    id: string;
    codigo: string;
    estado: string;
    inicia_en: string;
    duracion_min: number;
    precio_cobrado: number | null;
    moneda: string;
    motivo_visita: string | null;
    pacientes: { nombre: string; apellido: string; telefono: string };
    profesional_sede: {
      profesionales: { nombre: string; apellido: string };
      sedes: { nombre: string };
    };
    servicios: { nombre: string };
  };

  return {
    id: row.id,
    codigo: row.codigo,
    estado: row.estado,
    iniciaEn: row.inicia_en,
    duracionMin: row.duracion_min,
    precioCobrado: row.precio_cobrado,
    moneda: row.moneda,
    motivoVisita: row.motivo_visita,
    pacienteNombre: row.pacientes.nombre,
    pacienteApellido: row.pacientes.apellido,
    pacienteTelefono: row.pacientes.telefono,
    profesionalNombre: row.profesional_sede.profesionales.nombre,
    profesionalApellido: row.profesional_sede.profesionales.apellido,
    sedeNombre: row.profesional_sede.sedes.nombre,
    servicioNombre: row.servicios.nombre,
  };
}

export async function consultarCitasActivasPorTelefono(
  tenantId: string,
  telefono: string
): Promise<CitaDetalle[]> {
  const db = getDb();
  const { data, error } = await db
    .from("citas")
    .select(`
      id, codigo, estado, inicia_en, duracion_min, precio_cobrado, moneda, motivo_visita,
      pacientes!inner ( nombre, apellido, telefono ),
      profesional_sede!inner (
        profesionales!inner ( nombre, apellido ),
        sedes!inner ( nombre )
      ),
      servicios!inner ( nombre )
    `)
    .eq("tenant_id", tenantId)
    .eq("pacientes.telefono", telefono)
    .in("estado", ["pendiente", "confirmada"])
    .is("deleted_at", null)
    .gte("inicia_en", new Date().toISOString())
    .order("inicia_en", { ascending: true });

  if (error) throw new DomainError("DB_ERROR", error.message);

  type Row = {
    id: string;
    codigo: string;
    estado: string;
    inicia_en: string;
    duracion_min: number;
    precio_cobrado: number | null;
    moneda: string;
    motivo_visita: string | null;
    pacientes: { nombre: string; apellido: string; telefono: string };
    profesional_sede: {
      profesionales: { nombre: string; apellido: string };
      sedes: { nombre: string };
    };
    servicios: { nombre: string };
  };

  return (data as unknown as Row[]).map(row => ({
    id: row.id,
    codigo: row.codigo,
    estado: row.estado,
    iniciaEn: row.inicia_en,
    duracionMin: row.duracion_min,
    precioCobrado: row.precio_cobrado,
    moneda: row.moneda,
    motivoVisita: row.motivo_visita,
    pacienteNombre: row.pacientes.nombre,
    pacienteApellido: row.pacientes.apellido,
    pacienteTelefono: row.pacientes.telefono,
    profesionalNombre: row.profesional_sede.profesionales.nombre,
    profesionalApellido: row.profesional_sede.profesionales.apellido,
    sedeNombre: row.profesional_sede.sedes.nombre,
    servicioNombre: row.servicios.nombre,
  }));
}
