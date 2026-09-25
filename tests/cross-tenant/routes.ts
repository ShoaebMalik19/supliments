import { eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { brands, memberships } from "@/db/schema";
import { createUser, type createTenant } from "../helpers";
import * as brandRoute from "@/app/api/brands/[id]/route";
import * as memberRoute from "@/app/api/members/[id]/route";

type Tenant = Awaited<ReturnType<typeof createTenant>>;
export type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

export type TenantRouteCase = {
  /** Path of the route file relative to the repo root; checked by the registry meta-test. */
  file: string;
  url: (id: string) => string;
  /** Creates a row owned by `owner` and returns its id. */
  seed: (owner: Tenant) => Promise<string>;
  /** Privileged read of the row, used to prove a failed mutation changed nothing. */
  snapshot: (id: string) => Promise<unknown>;
  read: Handler[];
  mutate: { method: string; handler: Handler; body?: unknown }[];
};

/**
 * Every API route that touches tenant data MUST be listed here.
 * The meta-test in isolation.test.ts fails if a tenantRoute/withTenant route file is missing.
 */
export const tenantRoutes: TenantRouteCase[] = [
  {
    file: "src/app/api/brands/[id]/route.ts",
    url: (id) => `http://test/api/brands/${id}`,
    seed: async (b) => b.brand.id,
    snapshot: async (id) =>
      (await privilegedDb().select().from(brands).where(eq(brands.id, id)))[0],
    read: [brandRoute.GET],
    mutate: [{ method: "PATCH", handler: brandRoute.PATCH, body: { name: "pwned" } }],
  },
  {
    file: "src/app/api/members/[id]/route.ts",
    url: (id) => `http://test/api/members/${id}`,
    seed: async (b) => {
      const user = await createUser();
      const [m] = await privilegedDb()
        .insert(memberships)
        .values({ orgId: b.org.id, userId: user.id, role: "member" })
        .returning();
      return m!.id;
    },
    snapshot: async (id) =>
      (await privilegedDb().select().from(memberships).where(eq(memberships.id, id)))[0],
    read: [memberRoute.GET],
    mutate: [
      { method: "PATCH", handler: memberRoute.PATCH, body: { role: "admin" } },
      { method: "DELETE", handler: memberRoute.DELETE },
    ],
  },
];
