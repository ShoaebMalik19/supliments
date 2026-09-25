import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { auditLogs, platformAdmins } from "@/db/schema";
import { setSessionSourceForTests } from "@/modules/auth";
import { setStorageProviderForTests } from "@/modules/assets";
import { fakeStorage } from "./fake-storage";
import { FakeSession } from "./fake-session";
import { createTenant, createUser } from "./helpers";
import { adminRoutes, HTTP_METHODS, prepareAdminRoutes, type AdminRouteCase } from "./admin-routes";

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const session = new FakeSession();
let owner: Awaited<ReturnType<typeof createTenant>>;
let admin: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  setSessionSourceForTests(session);
  setStorageProviderForTests(fakeStorage);
  owner = await createTenant("Not an admin");
  admin = await createUser();
  await privilegedDb().insert(platformAdmins).values({ userId: admin.id });
  await prepareAdminRoutes();
});
afterAll(() => {
  setSessionSourceForTests(null);
  setStorageProviderForTests(null);
});

function methods(route: AdminRouteCase) {
  const mod = route.module as Record<string, Handler | undefined>;
  return HTTP_METHODS.flatMap((m) => (mod[m] ? [[m, mod[m]] as const] : []));
}

async function call(route: AdminRouteCase, method: string, handler: Handler) {
  const id = route.id ? await route.id(owner) : "";
  const hasBody = method !== "GET" && method !== "DELETE";
  const req = new Request(`http://test/${route.file}`, {
    method,
    headers: { "content-type": "application/json" },
    body: hasBody ? JSON.stringify(route.body?.(id) ?? {}) : undefined,
  });
  return handler(req, { params: Promise.resolve({ id }) });
}

describe.each(adminRoutes)("admin route: $file", (route) => {
  it("a non-admin org owner gets 404 on every method and nothing is written", async () => {
    session.actAs(owner.owner);
    for (const [m, h] of methods(route)) {
      expect((await call(route, m, h)).status, m).toBe(404);
    }
    const audits = await privilegedDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, owner.owner.id));
    expect(audits).toEqual([]);
  });

  it("unauthenticated requests get 404", async () => {
    session.actAs(null);
    for (const [m, h] of methods(route)) expect((await call(route, m, h)).status, m).toBe(404);
  });

  it("control: a platform admin succeeds (the 404 is authorization, not a broken route)", async () => {
    session.actAs(admin);
    for (const [m, h] of methods(route)) {
      const res = await call(route, m, h);
      expect(res.status, `${m} ${await res.clone().text()}`).toBeLessThan(300);
    }
  });
});

describe("admin registry completeness", () => {
  const root = join(import.meta.dirname, "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : f === "route.ts" ? [p] : [];
    });
  const files = walk(join(root, "src/app/api/admin"));

  it("every route file under src/app/api/admin is registered in admin-routes.ts", () => {
    const registered = new Set(adminRoutes.map((r) => r.file));
    expect(files.map((f) => relative(root, f)).filter((f) => !registered.has(f))).toEqual([]);
  });

  it("every admin route file wraps its handlers in adminRoute", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const exported = src.match(/export const (GET|POST|PUT|PATCH|DELETE)\b/g) ?? [];
      const wrapped = src.match(/export const (GET|POST|PUT|PATCH|DELETE) = adminRoute\b/g) ?? [];
      expect(wrapped.length, relative(root, f)).toBe(exported.length);
      expect(exported.length).toBeGreaterThan(0);
    }
  });

  it("every registered module exports at least one handler", () => {
    for (const r of adminRoutes) expect(methods(r).length, r.file).toBeGreaterThan(0);
  });
});
