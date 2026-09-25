import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { withTenant, type TenantDb } from "@/db/tenant";
import {
  fulfillmentOrders,
  orderEvents,
  orderItems,
  orders,
  reviewQueueItems,
  shipmentItems,
  shipments,
} from "@/db/schema";
import { IntegrationUnavailableError, pushShipmentToStore } from "@/modules/integrations";
import { registerJob, enqueue } from "@/modules/jobs";
import {
  canTransition,
  ORDER_PAID_JOB,
  paidOrdersAwaitingSubmission,
  transitionOrder,
  type OrderStatus,
} from "@/modules/orders";
import type { FulfillmentStatusUpdate } from "./provider";
import {
  batchFulfillmentOrder,
  centerAdapterKey,
  getBatch,
  routeItems,
  scanStuckOrders,
  settleBatch,
  STUCK_SCAN_JOB,
  type FoSnapshot,
} from "./platform";
import { fulfillmentProvider } from "./providers";
import { FO_RANK, ORDER_FOR_FO, ORDER_RANK } from "./state";

export * from "./provider";
export {
  batchFile,
  createDispatchBatch,
  getBatch,
  listBatches,
  scanStuckOrders,
  scheduleStuckScan,
  STUCK_THRESHOLDS,
} from "./platform";

export const PUSH_TO_STORE_JOB = "fulfillment.push_to_store";

async function flag(t: TenantDb, entityType: string, entityId: string) {
  await t.tx
    .insert(reviewQueueItems)
    .values({ orgId: t.orgId, type: "failed_fulfillment", entityType, entityId })
    .onConflictDoNothing();
}

/**
 * Paid order → fulfillment orders (one per routed center), idempotency keys recorded before any
 * export, order → `submitted`. Safe to run repeatedly.
 */
export async function submitPaidOrder(orgId: string, orderId: string) {
  const items = await withTenant(orgId, (t) =>
    t.tx
      .select({ id: orderItems.id, skuId: orderItems.skuId, status: orderItems.status })
      .from(orderItems)
      .where(and(eq(orderItems.orgId, orgId), eq(orderItems.orderId, orderId))),
  );
  const live = items.filter((i) => i.skuId && i.status !== "cancelled") as {
    id: string;
    skuId: string;
  }[];
  const routing = await routeItems(live);
  const adapterKeys = new Map<string, string>();
  for (const fc of routing.centers.keys()) adapterKeys.set(fc, (await centerAdapterKey(fc))!);

  return withTenant(orgId, async (t) => {
    const ready = await paidOrdersAwaitingSubmission(t);
    if (!ready.some((o) => o.id === orderId)) return { submitted: false as const };
    if (routing.unroutable.length || routing.centers.size === 0) {
      await transitionOrder(t, orderId, "needs_review", {
        type: "fulfillment_unroutable",
        actorType: "system",
        payload: { itemIds: routing.unroutable },
        holdReason: "no fulfillment center for some items",
      });
      await flag(t, "order", orderId);
      return { submitted: false as const };
    }
    const created: string[] = [];
    for (const [fcId, itemIds] of routing.centers) {
      const snapshot: FoSnapshot = { itemIds };
      const [fo] = await t.tx
        .insert(fulfillmentOrders)
        .values({
          orgId,
          orderId,
          fulfillmentCenterId: fcId,
          adapterKey: adapterKeys.get(fcId)!,
          idempotencyKey: `fo:${orderId}:${fcId}`,
          requestSnapshot: snapshot,
        })
        .onConflictDoNothing({ target: fulfillmentOrders.idempotencyKey })
        .returning({ id: fulfillmentOrders.id });
      if (fo) created.push(fo.id);
      await t.tx
        .update(orderItems)
        .set({ status: "submitted" })
        .where(and(eq(orderItems.orgId, orgId), inArray(orderItems.id, itemIds)));
    }
    await transitionOrder(t, orderId, "submitted", {
      type: "submitted_to_fulfillment",
      actorType: "system",
      payload: { fulfillmentOrderIds: created },
    });
    return { submitted: true as const, fulfillmentOrderIds: created };
  });
}

async function advanceOrder(t: TenantDb, orderId: string, to: OrderStatus, payload: object) {
  const [order] = await t.tx
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) return;
  if ((ORDER_RANK[order.status] ?? 99) >= (ORDER_RANK[to] ?? 0)) return;
  if (!canTransition(order.status, to)) return;
  await transitionOrder(t, orderId, to, {
    type: `fulfillment_${to}`,
    actorType: "system",
    payload: payload as Record<string, unknown>,
  });
}

type ApplyOutcome = "applied" | "duplicate" | "unknown_status" | "conflict" | "ignored";

async function applyUpdate(
  t: TenantDb,
  foId: string,
  u: FulfillmentStatusUpdate,
): Promise<ApplyOutcome> {
  const [fo] = await t.tx
    .select()
    .from(fulfillmentOrders)
    .where(and(eq(fulfillmentOrders.id, foId), eq(fulfillmentOrders.orgId, t.orgId)))
    .for("update");
  if (!fo) return "ignored";

  if (u.status === "unknown") {
    await flag(t, "fulfillment_order", fo.id);
    return "unknown_status";
  }
  if (u.status === "cancelled") {
    if (fo.status === "shipped" || fo.status === "cancelled") return "duplicate";
    await t.update(fulfillmentOrders, fo.id, {
      status: "cancelled",
      lastError: `partner: ${u.partnerStatus}`,
    });
    await flag(t, "fulfillment_order", fo.id);
    return "applied";
  }

  if (u.status === "shipped") {
    const tracking = u.tracking!;
    const [existing] = await t.tx
      .select()
      .from(shipments)
      .where(
        and(eq(shipments.carrier, tracking.carrier), eq(shipments.trackingNumber, tracking.number)),
      );
    if (existing) return existing.fulfillmentOrderId === fo.id ? "duplicate" : "conflict";
    if (fo.status === "shipped") return "conflict";
    const [order] = await t.tx.select().from(orders).where(eq(orders.id, fo.orderId));
    const itemIds = (fo.requestSnapshot as FoSnapshot).itemIds;
    const items = await t.tx
      .select({ id: orderItems.id, quantity: orderItems.quantity })
      .from(orderItems)
      .where(and(eq(orderItems.orgId, t.orgId), inArray(orderItems.id, itemIds)));
    const shipment = await t.insert(shipments, {
      fulfillmentOrderId: fo.id,
      carrier: tracking.carrier,
      trackingNumber: tracking.number,
      trackingUrl: tracking.url,
      shippedAt: u.shippedAt ?? new Date(),
      currency: order!.currency,
      status: "in_transit",
      lotNumber: u.lotNumber,
      batchCode: u.batchCode,
    });
    for (const item of items) {
      await t.insert(shipmentItems, {
        shipmentId: shipment.id,
        orderItemId: item.id,
        quantity: item.quantity,
        lotNumber: u.lotNumber,
        batchCode: u.batchCode,
        expiresOn: u.expiresOn,
      });
      await t.update(orderItems, item.id, {
        status: "shipped",
        lotNumber: u.lotNumber,
        batchCode: u.batchCode,
        expiresOn: u.expiresOn,
      });
    }
    await t.update(fulfillmentOrders, fo.id, {
      status: "shipped",
      acceptedAt: fo.acceptedAt ?? new Date(),
    });
    await enqueue(t, {
      kind: PUSH_TO_STORE_JOB,
      payload: { shipmentId: shipment.id },
      dedupeKey: `push:${shipment.id}`,
    });
    const siblings = await t.tx
      .select({ status: fulfillmentOrders.status })
      .from(fulfillmentOrders)
      .where(and(eq(fulfillmentOrders.orgId, t.orgId), eq(fulfillmentOrders.orderId, fo.orderId)));
    const payload = {
      shipmentId: shipment.id,
      carrier: tracking.carrier,
      trackingNumber: tracking.number,
      lotNumber: u.lotNumber,
    };
    if (siblings.every((s) => s.status === "shipped" || s.status === "cancelled"))
      await advanceOrder(t, fo.orderId, "shipped", payload);
    else
      await t.insert(orderEvents, {
        orderId: fo.orderId,
        type: "partial_shipment",
        actorType: "system",
        payload,
      });
    return "applied";
  }

  if ((FO_RANK[fo.status] ?? 99) >= (FO_RANK[u.status] ?? 0)) return "duplicate";
  await t.update(fulfillmentOrders, fo.id, {
    status: u.status,
    ...(u.status === "accepted" && { acceptedAt: new Date() }),
  });
  await advanceOrder(t, fo.orderId, ORDER_FOR_FO[u.status]!, { fulfillmentOrderId: fo.id });
  return "applied";
}

export type ImportReport = {
  applied: string[];
  duplicates: string[];
  unmatched: { row: number; reference: string }[];
  unknownStatus: { row: number; reference: string; partnerStatus: string }[];
  conflicts: { row: number; reference: string }[];
  errors: { row: number; message: string }[];
};

/** Idempotent import of a partner status report into a dispatch batch; matched on our reference. */
export async function importDispatchResults(
  adminUserId: string,
  batchId: string,
  data: Uint8Array,
) {
  const batch = await getBatch(batchId);
  if (!batch) return null;
  const parsed = await fulfillmentProvider(batch.adapterKey).ingestStatusReport(data);
  const report: ImportReport = {
    applied: [],
    duplicates: [],
    unmatched: [],
    unknownStatus: [],
    conflicts: [],
    errors: parsed.errors,
  };
  for (const u of parsed.updates) {
    const fo = await batchFulfillmentOrder(batchId, u.reference);
    if (!fo) {
      report.unmatched.push({ row: u.row, reference: u.reference });
      continue;
    }
    let outcome: ApplyOutcome;
    try {
      outcome = await withTenant(fo.orgId, (t) => applyUpdate(t, fo.id, u));
    } catch (e) {
      const msg = (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message;
      if (/unique|duplicate key/i.test(msg)) outcome = "conflict";
      else {
        report.errors.push({ row: u.row, message: `could not apply: ${msg.slice(0, 200)}` });
        continue;
      }
    }
    if (outcome === "applied") report.applied.push(u.reference);
    else if (outcome === "duplicate" || outcome === "ignored") report.duplicates.push(u.reference);
    else if (outcome === "unknown_status")
      report.unknownStatus.push({
        row: u.row,
        reference: u.reference,
        partnerStatus: u.partnerStatus,
      });
    else report.conflicts.push({ row: u.row, reference: u.reference });
  }
  await settleBatch(adminUserId, batchId, report);
  return report;
}

/** Pushes one shipment's fulfillment + tracking to the order's store. Never pushes twice. */
export async function pushShipment(orgId: string, shipmentId: string) {
  const ctx = await withTenant(orgId, async (t) => {
    const shipment = await t.find(shipments, shipmentId);
    if (!shipment || shipment.pushedToStoreAt) return null;
    const fo = (await t.find(fulfillmentOrders, shipment.fulfillmentOrderId))!;
    const order = (await t.find(orders, fo.orderId))!;
    const lines = await t.tx
      .select({
        externalLineItemId: orderItems.externalLineItemId,
        quantity: shipmentItems.quantity,
      })
      .from(shipmentItems)
      .innerJoin(orderItems, eq(orderItems.id, shipmentItems.orderItemId))
      .where(and(eq(shipmentItems.orgId, orgId), eq(shipmentItems.shipmentId, shipmentId)));
    return { shipment, order, lines };
  });
  if (!ctx) return { pushed: false };
  const { shipment, order, lines } = ctx;
  const event = (type: string, payload: object) =>
    withTenant(orgId, async (t) => {
      await t.insert(orderEvents, {
        orderId: order.id,
        type,
        actorType: "system",
        payload: payload as Record<string, unknown>,
      });
      if (type === "tracking_pushed_to_store")
        await t.update(shipments, shipmentId, { pushedToStoreAt: new Date() });
      else await flag(t, "shipment", shipmentId);
    });
  if (!order.integrationId || !order.externalOrderId) {
    await event("tracking_push_skipped", { shipmentId, reason: "order has no store" });
    return { pushed: false };
  }
  try {
    const res = await pushShipmentToStore(orgId, order.integrationId, {
      externalOrderId: order.externalOrderId,
      lines: lines
        .filter((l) => l.externalLineItemId)
        .map((l) => ({ externalLineItemId: l.externalLineItemId!, quantity: l.quantity })),
      tracking: {
        number: shipment.trackingNumber!,
        carrier: shipment.carrier,
        url: shipment.trackingUrl,
      },
      idempotencyKey: `shipment:${shipmentId}`,
    });
    await event("tracking_pushed_to_store", {
      shipmentId,
      externalFulfillmentId: res.externalFulfillmentId,
      trackingNumber: shipment.trackingNumber,
    });
    return { pushed: true, externalFulfillmentId: res.externalFulfillmentId };
  } catch (e) {
    if (e instanceof IntegrationUnavailableError) {
      await event("tracking_push_blocked", { shipmentId, reason: e.message });
      return { pushed: false };
    }
    throw e;
  }
}

export async function orderShipments(t: TenantDb, orderId: string) {
  return t.tx
    .select({
      id: shipments.id,
      carrier: shipments.carrier,
      trackingNumber: shipments.trackingNumber,
      trackingUrl: shipments.trackingUrl,
      shippedAt: shipments.shippedAt,
      status: shipments.status,
      lotNumber: shipments.lotNumber,
      pushedToStoreAt: shipments.pushedToStoreAt,
    })
    .from(shipments)
    .innerJoin(fulfillmentOrders, eq(fulfillmentOrders.id, shipments.fulfillmentOrderId))
    .where(and(eq(shipments.orgId, t.orgId), eq(fulfillmentOrders.orderId, orderId)))
    .orderBy(asc(shipments.createdAt));
}

const orderPayload = z.object({ orderId: z.uuid() });
const shipmentPayload = z.object({ shipmentId: z.uuid() });

const requireOrg = (orgId: string | null) => {
  if (!orgId) throw new Error("fulfillment job without org");
  return orgId;
};

export function registerFulfillmentJobs() {
  registerJob(ORDER_PAID_JOB, async (payload, job) => {
    await submitPaidOrder(requireOrg(job.orgId), orderPayload.parse(payload).orderId);
  });
  registerJob(PUSH_TO_STORE_JOB, async (payload, job) => {
    await pushShipment(requireOrg(job.orgId), shipmentPayload.parse(payload).shipmentId);
  });
  registerJob(STUCK_SCAN_JOB, async () => {
    await scanStuckOrders();
  });
}
