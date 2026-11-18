import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { privilegedDb } from "@/db/privileged";
import { withTenant, type TenantDb } from "@/db/tenant";
import { brands, memberships, organizations, users } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { session } from "@/modules/auth/session";
import { errorResponse, forbidden, json, notFound, unauthorized } from "@/lib/http";
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
  return privilegedDb().transaction((tx) => provisionInTx(tx, input));
}

/**
 * First sign-in without a signup form (social login): give the user their own org as owner,
 * exactly once even if two callbacks race. Returns null when the user already belongs to one.
 */
export async function ensureOrganizationFor(input: { userId: string; email: string }) {
  return privilegedDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.userId}))`);
    const [existing] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, input.userId))
      .limit(1);
    if (existing) return null;
    const local = input.email
      .split("@")[0]
      ?.replace(/[^\p{L}\p{N} ._-]/gu, "")
      .slice(0, 60);
    return provisionInTx(tx, { ...input, orgName: `${local || "My"} brand` });
  });
}

async function provisionInTx(tx: Tx, input: { userId: string; email: string; orgName: string }) {
  {
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
  }
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
      return out instanceof Response ? out : json(out);
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

/** People who receive an org's operational email: its owners and admins. */
export async function orgAdminRecipients(orgId: string) {
  return privilegedDb()
    .select({ userId: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), inArray(memberships.role, ["owner", "admin"])))
    .orderBy(asc(memberships.createdAt));
}

export async function userEmail(userId: string) {
  const [u] = await privilegedDb()
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return u?.email ?? null;
}

export async function renameOrganization(ctx: TenantContext, t: TenantDb, rawName: unknown) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name.length < 2 || name.length > 100) return null;
  const [before] = await t.tx.select().from(organizations).where(eq(organizations.id, t.orgId));
  await t.tx.update(organizations).set({ name }).where(eq(organizations.id, t.orgId));
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "org.renamed",
      entityType: "organization",
      entityId: t.orgId,
      before: { name: before?.name },
      after: { name },
    },
    t.tx,
  );
  return name;
}

export {
  acceptInvite,
  invitePreview,
  inviteMember,
  listPendingInvites,
  revokeInvite,
  INVITE_TTL_MS,
  type AcceptOutcome,
} from "./invitations";
