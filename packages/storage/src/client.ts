import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "@jqp/core";

let client: SupabaseClient | undefined;

/** Singleton Supabase client using the service_role key. Server-side only — never import this package from browser code. */
export function getSupabaseClient(): SupabaseClient {
  if (client) return client;
  const env = loadEnv();
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return client;
}
