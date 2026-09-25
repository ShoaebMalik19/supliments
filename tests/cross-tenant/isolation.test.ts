import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { brands } from "@/db/schema";
import { setSessionSourceForTests } from "@/modules/auth";
import { tenantRoute } from "@/modules/tenancy";
import { setStorageProviderForTests } from "@/modules/assets";
import { fakeStorage } from "../fake-storage";
import { FakeSession } from "../fake-session";
import { createTenant } from "../helpers";
import { callRoute, tenantRoutes, unscopedTenantRoutes, type Handler } from "./routes";

const session = new FakeSession();
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;

beforeAll(async () => {
  setSessionSourceForTests(session);
  setStorageProviderForTests(fakeStorage);
  A = await createTenant("Tenant A");
  B = await createTenant("Tenant B");
});
afterAll(() => {
  setSessionSourceForTests(null);
  setStorageProviderForTests(null);
});
beforeEach(() => session.actAs(A.owner));

const call = callRoute;

async function expectIsolated(
  handler: Handler,
  method: string,
  url: string,
  id: string,
  body?: unknown,
) {
  const res = await call(handler, method, url, id, body);
  expect(res.status, `${method} ${url} as tenant A`).toBe(404);
}

describe.each(tenantRoutes)("cross-tenant: $file", (route) => {
  it("tenant A cannot read tenant B's row (404)", async () => {
    const id = await route.seed(B);
    for (const h of route.read) await expectIsolated(h, "GET", route.url(id), id);
  });

  it("tenant A cannot mutate tenant B's row (404, row unchanged)", async () => {
    for (const m of route.mutate) {
      const id = await route.seed(B);
      const before = await route.snapshot(id);
      await expectIsolated(m.handler, m.method, route.url(id), id, m.body);
      expect(await route.snapshot(id)).toEqual(before);
    }
  });

  it("forging the active-org cookie to tenant B does not help", async () => {
    session.actAs(A.owner, B.org.id);
    const id = await route.seed(B);
    for (const h of route.read) await expectIsolated(h, "GET", route.url(id), id);
  });

  it("control: tenant B can read its own row (the 404 is isolation, not a broken route)", async () => {
    session.actAs(B.owner);
    const id = await route.seed(B);
    for (const h of route.read) expect((await call(h, "GET", route.url(id), id)).status).toBe(200);
  });

  it("control: tenant B can perform each mutation on its own row", async () => {
    session.actAs(B.owner);
    for (const m of route.mutate) {
      const id = await route.seed(B);
      const res = await call(m.handler, m.method, route.url(id), id, m.body);
      expect(res.status, `${m.method} ${await res.clone().text()}`).toBeLessThan(300);
    }
  });

  it("unauthenticated requests get 401", async () => {
    session.actAs(null);
    const id = await route.seed(B);
    for (const h of route.read) expect((await call(h, "GET", route.url(id), id)).status).toBe(401);
  });
});

describe.each(unscopedTenantRoutes)("cross-tenant (unscoped): $file", (route) => {
  it(route.reason, async () => {
    await route.check({ A, B, actAs: (u) => session.actAs(u) });
  });
});

describe("registry completeness", () => {
  it("every API route touching tenant data is registered in routes.ts", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : f === "route.ts" ? [p] : [];
      });
    const root = join(import.meta.dirname, "../..");
    const tenantFiles = walk(join(root, "src/app/api"))
      .filter((f) => /tenantRoute|withTenant/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f));
    const registered = new Set([...tenantRoutes, ...unscopedTenantRoutes].map((r) => r.file));
    expect(tenantFiles.filter((f) => !registered.has(f))).toEqual([]);
  });

  it("every exported method of a registered per-row route is exercised", () => {
    const root = join(import.meta.dirname, "../..");
    for (const r of tenantRoutes) {
      const src = readFileSync(join(root, r.file), "utf8");
      const exported = [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)].map(
        (m) => m[1],
      );
      const covered = new Set([
        ...(r.read.length ? ["GET"] : []),
        ...r.mutate.map((m) => m.method),
      ]);
      expect(
        exported.filter((m) => !covered.has(m!)),
        r.file,
      ).toEqual([]);
    }
  });
});

describe("the suite catches leaks", () => {
  const leakyViaPrivileged: Handler = async (_req, { params }) => {
    const { id } = await params;
    const [row] = await privilegedDb().select().from(brands).where(eq(brands.id, id));
    return row ? Response.json(row) : new Response(null, { status: 404 });
  };

  it.fails(
    "FAILS BY DESIGN: a handler that bypasses tenant scope is flagged as a leak",
    async () => {
      await expectIsolated(leakyViaPrivileged, "GET", "http://test/leaky", B.brand.id);
    },
  );

  it("control: the leaky handler really does return tenant B's row", async () => {
    const res = await call(leakyViaPrivileged, "GET", "http://test/leaky", B.brand.id);
    expect(res.status).toBe(200);
  });

  it("RLS still isolates a handler that forgets the org filter inside withTenant", async () => {
    const forgetsOrgFilter = tenantRoute<{ id: string }>("org:read", async (_c, t, _r, { id }) => {
      const [row] = await t.tx.select().from(brands).where(eq(brands.id, id));
      return row ?? null;
    });
    await expectIsolated(forgetsOrgFilter, "GET", "http://test/forgetful", B.brand.id);
  });
});

describe("tenant data layer + RLS", () => {
  it("cannot insert a row into another tenant's org (WITH CHECK)", async () => {
    await expect(
      withTenant(A.org.id, (t) =>
        t.tx.insert(brands).values({ orgId: B.org.id, name: "x", slug: "x" }),
      ),
    ).rejects.toThrow();
  });

  it("cannot see any other tenant rows via raw queries", async () => {
    const seen = await withTenant(A.org.id, (t) =>
      t.tx.select({ orgId: brands.orgId }).from(brands),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((r) => r.orgId))).toEqual(new Set([A.org.id]));
  });

  it("an app_user transaction without app.current_org sees zero tenant rows", async () => {
    const rows = await privilegedDb().transaction(async (tx) => {
      await tx.execute("set local role app_user");
      return tx.select().from(brands);
    });
    expect(rows).toHaveLength(0);
  });

  it("non-UUID ids are treated as not found", async () => {
    const res = await call(
      tenantRoutes[0]!.read[0]!,
      "GET",
      "http://test/api/brands/x",
      "' or 1=1 --",
    );
    expect(res.status).toBe(404);
  });
});
