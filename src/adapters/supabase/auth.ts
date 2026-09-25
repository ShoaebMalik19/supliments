import type { AuthProvider, AuthResult, AuthUser } from "@/modules/auth/provider";
import { supabaseServerClient } from "./server";

type SbUser = { id: string; email?: string } | null;
const toUser = (u: SbUser): AuthUser | null => (u ? { id: u.id, email: u.email ?? "" } : null);
const result = (error: { message: string } | null, user: SbUser): AuthResult =>
  error ? { ok: false, error: error.message } : { ok: true, user: toUser(user) };

export const supabaseAuth: AuthProvider = {
  async currentUser() {
    const sb = await supabaseServerClient();
    const { data } = await sb.auth.getUser();
    return toUser(data.user);
  },
  async signUp(email, password, emailRedirectTo) {
    const sb = await supabaseServerClient();
    const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo } });
    return result(error, data.user);
  },
  async signIn(email, password) {
    const sb = await supabaseServerClient();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    return result(error, data.user);
  },
  async signOut() {
    const sb = await supabaseServerClient();
    await sb.auth.signOut();
  },
  async sendPasswordReset(email, redirectTo) {
    const sb = await supabaseServerClient();
    await sb.auth.resetPasswordForEmail(email, { redirectTo });
  },
  async updatePassword(password) {
    const sb = await supabaseServerClient();
    const { data, error } = await sb.auth.updateUser({ password });
    return result(error, data.user);
  },
  async exchangeCode(code) {
    const sb = await supabaseServerClient();
    const { data, error } = await sb.auth.exchangeCodeForSession(code);
    return result(error, data.user);
  },
};
