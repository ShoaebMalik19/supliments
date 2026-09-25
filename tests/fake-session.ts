import type { AuthProvider, AuthResult, AuthUser, SessionSource } from "@/modules/auth/provider";
import { randomUUID } from "node:crypto";

export class FakeSession implements SessionSource {
  current: AuthUser | null = null;
  preferred: string | null = null;
  accounts = new Map<string, { user: AuthUser; password: string; verified: boolean }>();

  actAs(user: { id: string; email: string } | null, preferredOrgId: string | null = null) {
    this.current = user ? { id: user.id, email: user.email } : null;
    this.preferred = preferredOrgId;
  }

  auth(): AuthProvider {
    const ok = (user: AuthUser | null): AuthResult => ({ ok: true, user });
    return {
      currentUser: async () => this.current,
      signUp: async (email, password) => {
        if (this.accounts.has(email)) return { ok: false, error: "User already registered" };
        const user = { id: randomUUID(), email };
        this.accounts.set(email, { user, password, verified: false });
        return ok(user);
      },
      signIn: async (email, password) => {
        const a = this.accounts.get(email);
        if (!a || a.password !== password || !a.verified)
          return { ok: false, error: "Invalid login" };
        this.current = a.user;
        return ok(a.user);
      },
      signOut: async () => {
        this.current = null;
      },
      sendPasswordReset: async () => {},
      updatePassword: async (password) => {
        const a = [...this.accounts.values()].find((x) => x.user.id === this.current?.id);
        if (!a) return { ok: false, error: "No session" };
        a.password = password;
        return ok(a.user);
      },
      exchangeCode: async (code) => {
        const a = this.accounts.get(code);
        if (!a) return { ok: false, error: "bad code" };
        a.verified = true;
        this.current = a.user;
        return ok(a.user);
      },
    };
  }

  async preferredOrgId() {
    return this.preferred;
  }

  async requestMeta() {
    return { ip: "127.0.0.1", userAgent: "vitest" };
  }
}
