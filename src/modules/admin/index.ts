import { desc, eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { organizations, platformAdmins } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { session } from "@/modules/auth/session";
import { errorResponse, json, notFound } from "@/lib/http";

export type AdminContext = { userId: string };

export async function isPlatformAdmin(userId: string) {
  const rows = await privilegedDb()
    .select({ userId: platformAdmins.userId })
    .from(platformAdmins)
    .where(eq(platformAdmins.userId, userId));
  return rows.length > 0;
}

/** Non-admins get 404 so the admin surface is not discoverable. */
export async function requireAdmin(): Promise<AdminContext> {
  const user = await session().auth().currentUser();
  if (!user || !(await isPlatformAdmin(user.id))) throw notFound();
  return { userId: user.id };
}

export async function listOrganizations(admin: AdminContext) {
  const rows = await privilegedDb()
    .select({ id: organizations.id, name: organizations.name, status: organizations.status })
    .from(organizations)
    .orderBy(desc(organizations.createdAt))
    .limit(200);
  await recordAudit({
    orgId: null,
    actorUserId: admin.userId,
    actorType: "admin",
    action: "admin.orgs_listed",
  });
  return rows;
}

export async function setOrganizationStatus(
  admin: AdminContext,
  orgId: string,
  status: "active" | "suspended",
) {
  return privilegedDb().transaction(async (tx) => {
    const [before] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
    if (!before) return null;
    const [after] = await tx
      .update(organizations)
      .set({ status })
      .where(eq(organizations.id, orgId))
      .returning();
    await recordAudit(
      {
        orgId,
        actorUserId: admin.userId,
        actorType: "admin",
        action: "admin.org_status_changed",
        entityType: "organization",
        entityId: orgId,
        before: { status: before.status },
        after: { status: after!.status },
      },
      tx,
    );
    return after!;
  });
}

type RouteArgs<P> = { params: Promise<P> };

export function adminRoute<P>(
  handler: (admin: AdminContext, req: Request, params: P) => Promise<Response | object | null>,
) {
  return async (req: Request, args: RouteArgs<P>): Promise<Response> => {
    try {
      const admin = await requireAdmin();
      const out = await handler(admin, req, await args.params);
      if (out === null) throw notFound();
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}
