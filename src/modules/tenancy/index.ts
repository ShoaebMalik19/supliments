import { and, asc, eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { withTenant, type TenantDb } from "@/db/tenant";
import { brands, memberships, organizations, users } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { session } from "@/modules/auth/session";
import { errorResponse, forbidden, notFound, unauthorized } from "@/lib/http";
import { can, type Permission, type Role } from "./roles";

export { can, ROLES, type Role, type Permission } from "./roles";

export type TenantContext = { userId: string; email: string; orgId: string; role: Role };

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "brand"
  );
}

export async function provisionOrganization(input: {
  userId: string;
  email: string;
  orgName: string;
}) {
  return privilegedDb().transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ id: input.userId, email: input.email })
      .onConflictDoNothing({ target: users.id });
    const [org] = await tx.insert(organizations).values({ name: input.orgName }).returning();
    await tx.insert(memberships).values({
      orgId: org!.id,
      userId: input.userId,
      role: "owner",
      acceptedAt: new Date(),
    });
    await tx
      .insert(brands)
      .values({ orgId: org!.id, name: input.orgName, slug: slugify(input.orgName) });
    await recordAudit(
      {
        orgId: org!.id,
        actorUserId: input.userId,
        actorType: "user",
        action: "org.provisioned",
        entityType: "organization",
        entityId: org!.id,
        after: { name: input.orgName },
      },
      tx,
    );
    return org!;
  });
}

export async function resolveTenant(): Promise<TenantContext | null> {
  const s = session();
  const user = await s.auth().currentUser();
  if (!user) return null;
  const rows = await privilegedDb()
    .select({ orgId: memberships.orgId, role: memberships.role, status: organizations.status })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, user.id))
    .orderBy(asc(memberships.createdAt));
  const active = rows.filter((r) => r.status !== "suspended");
  const preferred = await s.preferredOrgId();
  const chosen = active.find((r) => r.orgId === preferred) ?? active[0];
  if (!chosen) return null;
  return { userId: user.id, email: user.email, orgId: chosen.orgId, role: chosen.role };
}

export async function requireTenant(permission: Permission = "org:read"): Promise<TenantContext> {
  const ctx = await resolveTenant();
  if (!ctx) throw unauthorized();
  if (!can(ctx.role, permission)) throw forbidden();
  return ctx;
}

type RouteArgs<P> = { params: Promise<P> };

/**
 * Wraps a route handler: resolves the tenant from the session (never the request),
 * runs inside withTenant, maps HttpErrors. Rows outside the tenant are simply absent → 404.
 */
export function tenantRoute<P>(
  permission: Permission,
  handler: (
    ctx: TenantContext,
    t: TenantDb,
    req: Request,
    params: P,
  ) => Promise<Response | object | null>,
) {
  return async (req: Request, args: RouteArgs<P>): Promise<Response> => {
    try {
      const ctx = await requireTenant(permission);
      const params = await args.params;
      const out = await withTenant(ctx.orgId, (t) => handler(ctx, t, req, params));
      if (out === null) throw notFound();
      return out instanceof Response ? out : Response.json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function orgMembers(t: TenantDb) {
  return t.tx
    .select({ id: memberships.id, role: memberships.role, email: users.email, userId: users.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, t.orgId)))
    .orderBy(asc(memberships.createdAt));
}
