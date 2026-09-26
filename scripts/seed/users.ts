import { randomUUID } from "node:crypto";
import { supabaseAuthAdmin } from "../../src/adapters/supabase/admin";
import type { AuthAdmin } from "../../src/modules/auth/provider";

export const DEMO_OWNER_EMAIL = "demo-owner@example.com";
export const DEMO_ADMIN_EMAIL = "demo-admin@example.com";

export type DemoUsers = {
  mode: "supabase" | "local-only";
  resolve(email: string): Promise<string>;
};

/**
 * With Supabase configured, demo accounts are real, email-confirmed Auth users (so they can sign
 * in) using SEED_DEMO_PASSWORD. Without it (tests, offline dev) ids are local-only and the
 * accounts cannot sign in; the seed says so.
 */
export function demoUsers(
  env: Record<string, string | undefined> = process.env,
  admin: AuthAdmin = supabaseAuthAdmin,
): DemoUsers {
  const configured = !!(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  if (!configured) return { mode: "local-only", resolve: async () => randomUUID() };
  const password = env.SEED_DEMO_PASSWORD ?? "";
  if (password.length < 10)
    throw new Error("SEED_DEMO_PASSWORD (min 10 chars) is required when seeding against Supabase");
  return {
    mode: "supabase",
    resolve: async (email) => (await admin.ensureUser(email, password)).id,
  };
}
