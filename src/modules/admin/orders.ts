import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { orders, organizations, reviewQueueItems } from "@/db/schema";
import { orderStatus } from "@/db/schema/enums";
import { recordAudit } from "@/modules/audit";
import { getOrder, recordOrderPayment, resolveOrder } from "@/modules/orders";
import { recordManualShipment } from "@/modules/fulfillment";
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

const searchInput = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(orderStatus.enumValues).optional(),
});

/** Cross-tenant order search for operators (by order number or id, org name, status). Audited. */
export async function adminSearchOrders(admin: AdminContext, raw: unknown, limit = 100) {
  const input = searchInput.parse(raw);
  const q = input.q || null;
  const conds = [
    input.status ? eq(orders.status, input.status) : undefined,
    q
      ? or(
          ilike(orders.externalOrderNumber, `%${q.replace(/[%_\\]/g, "\\$&")}%`),
          ilike(organizations.name, `%${q.replace(/[%_\\]/g, "\\$&")}%`),
          z.uuid().safeParse(q).success ? eq(orders.id, q) : undefined,
        )
      : undefined,
  ];
  const rows = await privilegedDb()
    .select({
      id: orders.id,
      number: orders.externalOrderNumber,
      status: orders.status,
      orgId: orders.orgId,
      orgName: organizations.name,
      retailTotalMinor: orders.retailTotalMinor,
      currency: orders.currency,
      placedAt: orders.placedAt,
      updatedAt: orders.updatedAt,
    })
    .from(orders)
    .innerJoin(organizations, eq(organizations.id, orders.orgId))
    .where(and(...conds))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
  await recordAudit({
    orgId: null,
    actorUserId: admin.userId,
    actorType: "admin",
    action: "admin.orders_searched",
    entityType: "order",
    after: { q, status: input.status ?? null, results: rows.length },
  });
  return rows;
}

const shipmentInput = z.strictObject({
  carrier: z.string().trim().min(1).max(60),
  trackingNumber: z.string().trim().min(3).max(80),
  trackingUrl: z.url().max(500).nullish(),
});

/** Records a shipment ops received outside the spreadsheet; tracking then goes to the store. */
export async function adminRecordShipment(admin: AdminContext, orderId: string, raw: unknown) {
  const r = shipmentInput.safeParse(raw);
  if (!r.success) throw badRequest("carrier and tracking number are required");
  const orgId = await orgOfOrder(orderId);
  if (!orgId) return null;
  const res = await withTenant(orgId, (t) =>
    recordManualShipment(t, orderId, { ...r.data, trackingUrl: r.data.trackingUrl ?? null }),
  );
  if (res.outcome === "no_open_fulfillment")
    throw badRequest("this order has no open fulfillment order (not yet submitted, or done)");
  if (res.outcome === "ambiguous")
    throw badRequest("this order is split across centers; use the dispatch import");
  if (res.outcome === "conflict")
    throw badRequest("that tracking number is already recorded on another shipment");
  await recordAudit({
    orgId,
    actorUserId: admin.userId,
    actorType: "admin",
    action: "admin.shipment_recorded",
    entityType: "order",
    entityId: orderId,
    after: { carrier: r.data.carrier, trackingNumber: r.data.trackingNumber, outcome: res.outcome },
  });
  return res;
}
