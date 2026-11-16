import type { AuthAdmin } from "@/modules/auth/provider";
import { serviceClient } from "./service";

async function findByEmail(email: string) {
  const admin = serviceClient().auth.admin;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

/** Idempotent: an existing account keeps its id and gets the given password, confirmed. */
export const supabaseAuthAdmin: AuthAdmin = {
  async ensureUser(email, password) {
    const admin = serviceClient().auth.admin;
    const created = await admin.createUser({ email, password, email_confirm: true });
    if (!created.error && created.data.user) return { id: created.data.user.id, created: true };
    const existing = await findByEmail(email);
    if (!existing) throw created.error ?? new Error(`could not create ${email}`);
    const updated = await admin.updateUserById(existing.id, { password, email_confirm: true });
    if (updated.error) throw updated.error;
    return { id: existing.id, created: false };
  },

  async health() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return { reachable: false, emailSignup: null, detail: "env not set" };
    try {
      const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
      if (!res.ok) return { reachable: false, emailSignup: null, detail: `HTTP ${res.status}` };
      const body = (await res.json()) as { external?: { email?: boolean } };
      return { reachable: true, emailSignup: body.external?.email ?? null, detail: "ok" };
    } catch (e) {
      return { reachable: false, emailSignup: null, detail: (e as Error).message.slice(0, 120) };
    }
  },
};
