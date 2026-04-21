// ================================================================
// supabase.ts — Cliente HTTP para Supabase (sin SDK externo).
// Mismo patrón que el PHP original pero en TypeScript.
// ================================================================
import { ENV } from "./env.js";

const BASE_HEADERS = {
  "apikey": ENV.SUPABASE_KEY,
  "Authorization": `Bearer ${ENV.SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

export interface SupabaseResponse<T = unknown> {
  status: number;
  data: T;
}

/** Llamada genérica a PostgREST */
export async function supabase<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: object | null,
  params?: Record<string, string>,
  extraHeaders?: Record<string, string>,
  expectedStatuses: number[] = [],
): Promise<SupabaseResponse<T>> {
  let url = ENV.SUPABASE_URL.replace(/\/$/, "") + path;
  if (params && Object.keys(params).length > 0) {
    url += "?" + new URLSearchParams(params).toString();
  }

  const res = await fetch(url, {
    method,
    headers: { ...BASE_HEADERS, ...extraHeaders },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  if (res.status >= 400) {
    const errorText = await res.text().catch(() => "");
    if (!expectedStatuses.includes(res.status)) {
      console.error(`[Supabase] ${method} ${path} → ${res.status}`, errorText.slice(0, 200));
    }
    return { status: res.status, data: null as T };
  }

  const data = await res.json().catch(() => null);
  return { status: res.status, data: data as T };
}

/** Llamada a una función RPC de Supabase */
export async function rpc<T = unknown>(
  fn: string,
  params: object,
): Promise<SupabaseResponse<T[]>> {
  return supabase<T[]>("POST", `/rest/v1/rpc/${fn}`, params);
}
