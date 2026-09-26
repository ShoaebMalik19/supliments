import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import type { TenantDb } from "@/db/tenant";
import {
  auditLogs,
  fulfillmentOrders,
  organizations,
  reviewQueueItems,
  shipments,
} from "@/db/schema";
import { reviewItemType } from "@/db/schema/enums";

export type ReviewItemType = (typeof reviewItemType.enumValues)[number];

const OPEN = ["open", "in_progress"] as const;

/**
 * Opens a review item in the tenant's own transaction so it commits with the state change.
 * A partial unique index allows one open item per (type, entity).
 */
export async function openReviewItem(
  t: TenantDb,
  input: { type: ReviewItemType; entityType: string; entityId: string; priority?: number },
) {
  return t.insert(reviewQueueItems, input);
}

export async function closeReviewItem(
  type: ReviewItemType,
  entityId: string,
  status: "done" | "dismissed" = "done",
) {
  const rows = await privilegedDb()
    .update(reviewQueueItems)
    .set({ status })
    .where(
      and(
        eq(reviewQueueItems.type, type),
        eq(reviewQueueItems.entityId, entityId),
        inArray(reviewQueueItems.status, [...OPEN]),
      ),
    )
    .returning({ id: reviewQueueItems.id });
  return rows.length;
}

export async function listOpenReviewItems(type: ReviewItemType, limit = 200) {
  return privilegedDb()
    .select()
    .from(reviewQueueItems)
    .where(and(eq(reviewQueueItems.type, type), inArray(reviewQueueItems.status, [...OPEN])))
    .orderBy(desc(reviewQueueItems.priority), asc(reviewQueueItems.createdAt))
    .limit(limit);
}

function linkFor(
  item: { entityType: string; entityId: string },
  orderOf: Map<string, string>,
): string | null {
  if (item.entityType === "order") return `/admin/orders/${item.entityId}`;
  if (item.entityType === "label") return "/admin/labels";
  const orderId = orderOf.get(item.entityId);
  return orderId ? `/admin/orders/${orderId}` : null;
}

/** Every open review item across types, oldest first within priority, with a link to act on. */
export async function listReviewQueue(admin: { userId: string }, limit = 500) {
  const db = privilegedDb();
  const items = await db
    .select({
      id: reviewQueueItems.id,
      type: reviewQueueItems.type,
      status: reviewQueueItems.status,
      entityType: reviewQueueItems.entityType,
      entityId: reviewQueueItems.entityId,
      priority: reviewQueueItems.priority,
      createdAt: reviewQueueItems.createdAt,
      orgId: reviewQueueItems.orgId,
      orgName: organizations.name,
    })
    .from(reviewQueueItems)
    .leftJoin(organizations, eq(organizations.id, reviewQueueItems.orgId))
    .where(inArray(reviewQueueItems.status, [...OPEN]))
    .orderBy(desc(reviewQueueItems.priority), asc(reviewQueueItems.createdAt))
    .limit(limit);
  const ids = (t: string) => items.filter((i) => i.entityType === t).map((i) => i.entityId);
  const orderOf = new Map<string, string>();
  const foIds = ids("fulfillment_order");
  if (foIds.length)
    for (const r of await db
      .select({ id: fulfillmentOrders.id, orderId: fulfillmentOrders.orderId })
      .from(fulfillmentOrders)
      .where(inArray(fulfillmentOrders.id, foIds)))
      orderOf.set(r.id, r.orderId);
  const shipmentIds = ids("shipment");
  if (shipmentIds.length)
    for (const r of await db
      .select({ id: shipments.id, orderId: fulfillmentOrders.orderId })
      .from(shipments)
      .innerJoin(fulfillmentOrders, eq(fulfillmentOrders.id, shipments.fulfillmentOrderId))
      .where(inArray(shipments.id, shipmentIds)))
      orderOf.set(r.id, r.orderId);
  await db.insert(auditLogs).values({
    orgId: null,
    actorUserId: admin.userId,
    actorType: "admin",
    action: "admin.review_queue_listed",
  });
  return items.map((i) => ({ ...i, link: linkFor(i, orderOf) }));
}

/** Closes one open item (done/dismissed) with an audited note. Null when not open. */
export async function resolveReviewItem(
  admin: { userId: string },
  id: string,
  input: { status: "done" | "dismissed"; note: string | null },
) {
  return privilegedDb().transaction(async (tx) => {
    const [item] = await tx
      .update(reviewQueueItems)
      .set({ status: input.status, assigneeUserId: admin.userId })
      .where(and(eq(reviewQueueItems.id, id), inArray(reviewQueueItems.status, [...OPEN])))
      .returning();
    if (!item) return null;
    await tx.insert(auditLogs).values({
      orgId: item.orgId,
      actorUserId: admin.userId,
      actorType: "admin",
      action: "admin.review_item_resolved",
      entityType: item.entityType,
      entityId: item.entityId,
      after: { reviewItemId: id, type: item.type, status: input.status, note: input.note },
    });
    return item;
  });
}
