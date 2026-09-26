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
};
