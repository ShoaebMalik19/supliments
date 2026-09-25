import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { orders, reviewQueueItems } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { getOrder, recordOrderPayment, resolveOrder } from "@/modules/orders";
import { badRequest } from "@/lib/http";
import type { AdminContext } from "./index";

const markPaidInput = z.strictObject({
  reference: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).nullish(),
});

/** The owning org of an order; admin actions then run inside that tenant's RLS scope. */
async function orgOfOrder(orderId: string) {
  if (!z.uuid().safeParse(orderId).success) return null;
  const [row] = await privilegedDb()
    .select({ orgId: orders.orgId })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row?.orgId ?? null;
}

export async function adminGetOrder(admin: AdminContext, orderId: string) {
  const orgId = await orgOfOrder(orderId);
  if (!orgId) return null;
  const detail = await withTenant(orgId, (t) => getOrder(t, orderId));
  await recordAudit({
    orgId,
    actorUserId: admin.userId,
    actorType: "admin",
    action: "admin.order_viewed",
    entityType: "order",
    entityId: orderId,
  });
  return detail && { orgId, ...detail };
}

/** Records an ops-confirmed payment (manual provider). Idempotent per order. */
export async function adminMarkOrderPaid(admin: AdminContext, orderId: string, raw: unknown) {
  const r = markPaidInput.safeParse(raw);
  if (!r.success) throw badRequest("reference is required");
  const orgId = await orgOfOrder(orderId);
  if (!orgId) return null;
  const out = await withTenant(orgId, (t) =>
    recordOrderPayment(t, admin, orderId, {
      reference: r.data.reference,
      note: r.data.note ?? null,
    }),
  );
  return out && { alreadyPaid: out.alreadyPaid, charge: out.charge };
}

/** Re-runs resolution + pricing of a needs_review order; closes its review items once it moves on. */
export async function adminResolveOrder(admin: AdminContext, orderId: string) {
  const orgId = await orgOfOrder(orderId);
  if (!orgId) return null;
  const status = await withTenant(orgId, (t) =>
    resolveOrder(t, { actorType: "admin", actorId: admin.userId }, orderId),
  );
  if (!status) return null;
  await privilegedDb().transaction(async (tx) => {
    if (status !== "needs_review")
      await tx
        .update(reviewQueueItems)
        .set({ status: "done" })
        .where(
          and(
            eq(reviewQueueItems.entityId, orderId),
            eq(reviewQueueItems.type, "failed_fulfillment"),
            inArray(reviewQueueItems.status, ["open", "in_progress"]),
          ),
        );
    await recordAudit(
      {
        orgId,
        actorUserId: admin.userId,
        actorType: "admin",
        action: "admin.order_resolve_attempted",
        entityType: "order",
        entityId: orderId,
        after: { status },
      },
      tx,
    );
  });
  return { status };
}
