import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
let fetchOverride: typeof fetch | null = null;

/** Service-role client: server-only (storage signing, auth admin). Never sent to browsers. */
export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  client ??= createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: fetchOverride ? { fetch: fetchOverride } : undefined,
  });
  return client;
}

export function setSupabaseFetchForTests(f: typeof fetch | null) {
  fetchOverride = f;
  client = null;
}
