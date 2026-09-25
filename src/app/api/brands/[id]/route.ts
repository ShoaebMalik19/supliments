import { z } from "zod";
import { brands } from "@/db/schema";
import { tenantRoute } from "@/modules/tenancy";
import { recordAudit } from "@/modules/audit";
import { badRequest } from "@/lib/http";

type Params = { id: string };

export const GET = tenantRoute<Params>("org:read", (_ctx, t, _req, { id }) => t.find(brands, id));

const patch = z.object({ name: z.string().trim().min(1).max(100) });

export const PATCH = tenantRoute<Params>("brand:write", async (ctx, t, req, { id }) => {
  const before = await t.find(brands, id);
  if (!before) return null;
  const body = patch.safeParse(await req.json().catch(() => null));
  if (!body.success) throw badRequest();
  const after = await t.update(brands, id, { name: body.data.name });
  await recordAudit(
    {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "brand.updated",
      entityType: "brand",
      entityId: id,
      before: { name: before.name },
      after: { name: after?.name },
    },
    t.tx,
  );
  return after;
});
