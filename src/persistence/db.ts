// src/persistence/db.ts
// Cliente Supabase único para todo el backend.
// Usa service_role key → bypasea RLS (el backend controla qué tenant ve qué
// pasándolo explícito a cada función RPC).
//
// Ningún archivo de domain/application/channels debe importar esto directo.
// Solo los repositorios en src/persistence/repositories/*.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ENV } from "../config/env.js";

let _client: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (_client) return _client;

  _client = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    db: {
      schema: "public",
    },
    global: {
      headers: {
        "x-citasmed-service": "backend",
      },
    },
  });

  return _client;
}

/**
 * Helper para llamar funciones RPC con tipado.
 * Todas las funciones RPC del sistema devuelven { success, error_code, error_message, ... }
 */
export async function rpc<T = unknown>(
  fnName: string,
  args: Record<string, unknown>
): Promise<{ data: T[] | null; error: Error | null }> {
  const db = getDb();
  const { data, error } = await db.rpc(fnName, args);

  if (error) {
    return { data: null, error: new Error(`RPC ${fnName} failed: ${error.message}`) };
  }
  return { data: data as T[], error: null };
}
