// src/persistence/repositories/tenants.repo.ts
// Lectura de tenants y canales conectados.
// El método clave es resolveByCanal: dado un identificador entrante
// (phone_number_id de WA, bot_username de Telegram), encuentra el tenant.

import { getDb } from "../db.js";
import { DomainError } from "../../domain/errors.js";

export interface Tenant {
  id: string;
  nombre_comercial: string;
  slug: string;
  tipo_entidad: "individual" | "clinica";
  plan: "trial" | "basico" | "pro" | "enterprise";
  estado: "activo" | "suspendido" | "cancelado";
  timezone: string;
  moneda: string;
  pais: string;
  configuracion: Record<string, unknown>;
}

export type TipoCanal =
  | "whatsapp_cloud"
  | "instagram"
  | "facebook_msg"
  | "web_widget"
  | "telegram";

export interface CanalConectado {
  id: string;
  tenant_id: string;
  tipo: TipoCanal;
  identificador: string;
  nombre_display: string | null;
  credenciales_cifradas: string;
  webhook_secret: string | null;
  configuracion: Record<string, unknown>;
  estado: "activo" | "pausado" | "error" | "no_verificado";
}

class TenantsRepo {
  async findById(tenantId: string): Promise<Tenant | null> {
    const db = getDb();
    const { data, error } = await db
      .from("tenants")
      .select("*")
      .eq("id", tenantId)
      .maybeSingle();

    if (error) throw new DomainError("DB_ERROR", error.message);
    return data as Tenant | null;
  }

  /**
   * Resuelve tenant + canal_conectado a partir de tipo de canal + identificador.
   * Caso típico: llega webhook de Telegram con bot_username "miBot",
   * el adapter pregunta "¿qué tenant maneja este bot?".
   */
  async resolveByCanal(
    tipo: TipoCanal,
    identificador: string
  ): Promise<{ tenant: Tenant; canal: CanalConectado } | null> {
    const db = getDb();
    const { data, error } = await db
      .from("canales_conectados")
      .select(`
        *,
        tenants!inner (*)
      `)
      .eq("tipo", tipo)
      .eq("identificador", identificador)
      .eq("estado", "activo")
      .maybeSingle();

    if (error) throw new DomainError("DB_ERROR", error.message);
    if (!data) return null;

    type Row = CanalConectado & { tenants: Tenant };
    const row = data as unknown as Row;

    // Validar tenant activo
    if (row.tenants.estado !== "activo") {
      return null;
    }

    return {
      tenant: row.tenants,
      canal: {
        id: row.id,
        tenant_id: row.tenant_id,
        tipo: row.tipo,
        identificador: row.identificador,
        nombre_display: row.nombre_display,
        credenciales_cifradas: row.credenciales_cifradas,
        webhook_secret: row.webhook_secret,
        configuracion: row.configuracion,
        estado: row.estado,
      },
    };
  }

  /** Lista canales activos de un tenant (para dashboard admin). */
  async listarCanalesPorTenant(tenantId: string): Promise<CanalConectado[]> {
    const db = getDb();
    const { data, error } = await db
      .from("canales_conectados")
      .select("*")
      .eq("tenant_id", tenantId)
      .neq("estado", "no_verificado");

    if (error) throw new DomainError("DB_ERROR", error.message);
    return (data ?? []) as CanalConectado[];
  }
}

export const tenantsRepo = new TenantsRepo();
