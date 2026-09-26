import { afterEach, describe, expect, it } from "vitest";
import { supabaseAuthAdmin } from "@/adapters/supabase/admin";
import { setSupabaseFetchForTests } from "@/adapters/supabase/service";
import { demoUsers } from "../scripts/seed/users";

const env = {
  NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  SEED_DEMO_PASSWORD: "long-enough-pw",
};

/** Minimal GoTrue admin API: create (422 on duplicate), list, update. */
function fakeGoTrue() {
  const users = new Map<
    string,
    { id: string; email: string; password: string; confirmed: boolean }
  >();
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const f: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    calls.push(`${method} ${url.pathname}`);
    if (auth !== "Bearer service-key") return json({ msg: "unauthorized" }, 401);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const view = (u: { id: string; email: string; confirmed: boolean }) => ({
      id: u.id,
      email: u.email,
      email_confirmed_at: u.confirmed ? new Date().toISOString() : null,
      aud: "authenticated",
      role: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    });
    if (url.pathname === "/auth/v1/admin/users" && method === "POST") {
      if ([...users.values()].some((u) => u.email === body.email))
        return json({ code: 422, error_code: "email_exists", msg: "already registered" }, 422);
      const u = {
        id: crypto.randomUUID(),
        email: body.email,
        password: body.password,
        confirmed: !!body.email_confirm,
      };
      users.set(u.id, u);
      return json(view(u));
    }
    if (url.pathname === "/auth/v1/admin/users" && method === "GET")
      return json({ users: [...users.values()].map(view), aud: "authenticated" });
    const m = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(url.pathname);
    if (m && method === "PUT") {
      const u = users.get(m[1]!)!;
      Object.assign(u, {
        password: body.password ?? u.password,
        confirmed: body.email_confirm ?? u.confirmed,
      });
      return json(view(u));
    }
    return json({ msg: "not found" }, 404);
  };
  return { f, users, calls };
}

afterEach(() => setSupabaseFetchForTests(null));

describe("seed demo users", () => {
  it("creates confirmed Supabase Auth users that can sign in, idempotently", async () => {
    const go = fakeGoTrue();
    setSupabaseFetchForTests(go.f);
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const accounts = demoUsers(env, supabaseAuthAdmin);
      expect(accounts.mode).toBe("supabase");
      const first = await accounts.resolve("demo-owner@example.com");
      const again = await accounts.resolve("demo-owner@example.com");
      expect(again).toBe(first);
      const u = go.users.get(first)!;
      expect(u).toMatchObject({
        email: "demo-owner@example.com",
        password: "long-enough-pw",
        confirmed: true,
      });
      expect(go.calls).toContain(`PUT /auth/v1/admin/users/${first}`);
    } finally {
      process.env = saved;
    }
  });

  it("refuses to seed Supabase without a real demo password", () => {
    expect(() => demoUsers({ ...env, SEED_DEMO_PASSWORD: "" })).toThrow(/SEED_DEMO_PASSWORD/);
  });

  it("without Supabase, says the accounts are local-only", () => {
    expect(demoUsers({}).mode).toBe("local-only");
  });
});
