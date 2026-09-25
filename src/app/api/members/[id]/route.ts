import { z } from "zod";
import { memberships } from "@/db/schema";
import { tenantRoute } from "@/modules/tenancy";
import { recordAudit } from "@/modules/audit";
import { badRequest, forbidden } from "@/lib/http";

type Params = { id: string };

export const GET = tenantRoute<Params>("org:read", (_ctx, t, _req, { id }) =>
  t.find(memberships, id),
);

const patch = z.object({ role: z.enum(["admin", "member", "designer", "read_only"]) });

export const PATCH = tenantRoute<Params>("members:manage", async (ctx, t, req, { id }) => {
  const before = await t.find(memberships, id);
  if (!before) return null;
  if (before.role === "owner") throw forbidden();
  const body = patch.safeParse(await req.json().catch(() => null));
  if (!body.success) throw badRequest();
  const after = await t.update(memberships, id, { role: body.data.role });
  await recordAudit(
    {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "membership.role_changed",
      entityType: "membership",
      entityId: id,
      before: { role: before.role },
      after: { role: after?.role },
    },
    t.tx,
  );
  return after;
});

export const DELETE = tenantRoute<Params>("members:manage", async (ctx, t, _req, { id }) => {
  const before = await t.find(memberships, id);
  if (!before) return null;
  if (before.role === "owner") throw forbidden();
  await t.remove(memberships, id);
  await recordAudit(
    {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "membership.removed",
      entityType: "membership",
      entityId: id,
      before: { userId: before.userId, role: before.role },
    },
    t.tx,
  );
  return { ok: true };
});
