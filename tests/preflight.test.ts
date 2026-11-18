import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privilegedDb } from "@/db/privileged";
import { platformAdmins } from "@/db/schema";
import { setStorageProviderForTests } from "@/modules/assets";
import { preflight } from "@/modules/admin/preflight";
import * as route from "@/app/api/cron/preflight/route";
import { seedPlatform } from "../scripts/seed/platform";
import { fakeStorage } from "./fake-storage";
import { createTenant, createUser } from "./helpers";

const SECRETS = {
  DATABASE_URL: "postgres://u:db-password-value@h/db",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
  SHOPIFY_API_SECRET: "shopify-secret-value",
  CRON_SECRET: "cron-secret-value",
  INTEGRATION_ENCRYPTION_KEY: "encryption-key-value",
};
const env = {
  ...SECRETS,
  NEXT_PUBLIC_SUPABASE_URL: "https://p.supabase.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  NEXT_PUBLIC_SITE_URL: "https://app.example.com",
  SHOPIFY_API_KEY: "key",
};
const auth = {
  ensureUser: async () => ({ id: "x", created: false }),
  health: async () => ({ reachable: true, emailSignup: true, detail: "ok" }),
};
const go = (over: Partial<Parameters<typeof preflight>[0]> = {}) =>
  preflight({ env, auth, origin: "https://app.example.com", ...over });
const byId = (r: Awaited<ReturnType<typeof preflight>>, id: string) =>
  r.checks.find((c) => c.id === id)!;

beforeAll(async () => {
  setStorageProviderForTests(fakeStorage);
  await seedPlatform();
  await createTenant("Preflight bystander");
  const admin = await createUser();
  await privilegedDb().insert(platformAdmins).values({ userId: admin.id });
});
afterAll(() => {
  fakeStorage.visibility = "private";
  setStorageProviderForTests(null);
});

describe("deployment preflight", () => {
  it("passes on a correctly configured, seeded system and proves the tenant path works", async () => {
    const r = await go();
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(byId(r, "db.tenant_isolation").detail).toMatch(/0 of \d+ brands visible/);
    expect(byId(r, "render.golden").status).toBe("ok");
    expect(fakeStorage.removed.some((k) => k.includes("platform/preflight/"))).toBe(true);
  });

  it("warns (never fails) while counsel's legal text is missing", async () => {
    const r = await go();
    expect(byId(r, "legal.pages")).toMatchObject({ status: "warn" });
    expect(byId(r, "legal.pages").detail).toMatch(/terms\.md, privacy\.md/);
  });

  it("never puts a secret value in its output", async () => {
    const text = JSON.stringify(await go({ env: { ...env, NEXT_PUBLIC_SITE_URL: undefined } }));
    for (const v of Object.values(SECRETS)) expect(text).not.toContain(v);
  });

  it("names each misconfiguration", async () => {
    const missing = await go({ env: { ...env, CRON_SECRET: "", SHOPIFY_API_KEY: undefined } });
    expect(byId(missing, "env.required")).toMatchObject({
      status: "fail",
      detail: "missing: SHOPIFY_API_KEY, CRON_SECRET",
    });

    const wrongHost = await go({ origin: "https://other.vercel.app" });
    expect(byId(wrongHost, "env.site_url").status).toBe("fail");
    expect(wrongHost.ok).toBe(false);

    fakeStorage.visibility = "public";
    expect(byId(await go(), "storage.bucket_private")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("PUBLIC"),
    });
    fakeStorage.visibility = "missing";
    expect(byId(await go(), "storage.bucket_private").status).toBe("fail");
    fakeStorage.visibility = "private";

    const authDown = await go({
      auth: {
        ...auth,
        health: async () => ({ reachable: false, emailSignup: null, detail: "HTTP 401" }),
      },
    });
    expect(byId(authDown, "auth.reachable")).toMatchObject({ status: "fail" });
  });

  it("the route needs the cron bearer secret and answers 404 without it", async () => {
    process.env.CRON_SECRET = "s3cret-for-test";
    const call = (h?: string) =>
      route.GET(
        new Request("https://app.example.com/api/cron/preflight", {
          headers: h ? { authorization: h } : {},
        }),
      );
    expect((await call()).status).toBe(404);
    expect((await call("Bearer wrong-secret-xx")).status).toBe(404);
    const res = await call("Bearer s3cret-for-test");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checks: { id: string }[] };
    expect(body.checks.length).toBeGreaterThan(10);
  });
});
