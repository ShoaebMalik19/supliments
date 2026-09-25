import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import type { Tx } from "@/db/client";
import {
  assets,
  auditLogs,
  brands,
  dispatchBatches,
  fulfillmentCenters,
  fulfillmentOrders,
  jobQueue,
  labels,
  orderEvents,
  orderItems,
  orders,
  partnerSkuMappings,
  reviewQueueItems,
  shipments,
  skus,
} from "@/db/schema";
import { signedUrlForAsset, storePlatformAsset } from "@/modules/assets";
import type { CanonicalFulfillmentOrder, ShipTo } from "./provider";
import { fulfillmentProvider } from "./providers";

export const ARTWORK_URL_TTL_SECONDS = 7 * 24 * 3600;

export type Routing = { centers: Map<string, string[]>; unroutable: string[] };
export type FoSnapshot = { itemIds: string[] };

/** MVP routing (§11.3): the SKU's default center, else the only active center. */
export async function routeItems(items: { id: string; skuId: string }[]): Promise<Routing> {
  const db = privilegedDb();
  const active = await db
    .select({ id: fulfillmentCenters.id })
    .from(fulfillmentCenters)
    .where(eq(fulfillmentCenters.isActive, true));
  const activeIds = new Set(active.map((c) => c.id));
  const skuRows = items.length
    ? await db
        .select({ id: skus.id, fc: skus.defaultFulfillmentCenterId })
        .from(skus)
        .where(inArray(skus.id, [...new Set(items.map((i) => i.skuId))]))
    : [];
  const fcBySku = new Map(skuRows.map((s) => [s.id, s.fc]));
  const fallback = active.length === 1 ? active[0]!.id : null;
  const centers = new Map<string, string[]>();
  const unroutable: string[] = [];
  for (const item of items) {
    const preferred = fcBySku.get(item.skuId);
    const fc = preferred && activeIds.has(preferred) ? preferred : preferred ? null : fallback;
    if (!fc) unroutable.push(item.id);
    else centers.set(fc, [...(centers.get(fc) ?? []), item.id]);
  }
  return { centers, unroutable };
}

export async function centerAdapterKey(fcId: string) {
  const [fc] = await privilegedDb()
    .select({ adapterKey: fulfillmentCenters.adapterKey })
    .from(fulfillmentCenters)
    .where(eq(fulfillmentCenters.id, fcId));
  return fc?.adapterKey ?? null;
}

export async function flagForReview(
  tx: Tx,
  input: {
    orgId: string | null;
    type: "failed_fulfillment" | "payment_hold";
    entityType: string;
    entityId: string;
    priority?: number;
  },
) {
  await tx.insert(reviewQueueItems).values(input).onConflictDoNothing();
}

/**
 * Collects every pending fulfillment order for a center (cross-tenant by design), exports them
 * through the center's adapter and stores the artifact. Idempotency keys already exist on each
 * fulfillment order; export only records batch membership. Audited per org touched.
 */
export async function createDispatchBatch(adminUserId: string, fulfillmentCenterId: string) {
  return privilegedDb().transaction(async (tx) => {
    const [fc] = await tx
      .select()
      .from(fulfillmentCenters)
      .where(eq(fulfillmentCenters.id, fulfillmentCenterId));
    if (!fc) return null;
    const pending = await tx
      .select()
      .from(fulfillmentOrders)
      .where(
        and(
          eq(fulfillmentOrders.fulfillmentCenterId, fc.id),
          eq(fulfillmentOrders.status, "pending"),
          isNull(fulfillmentOrders.dispatchBatchId),
        ),
      )
      .orderBy(asc(fulfillmentOrders.createdAt))
      .for("update", { skipLocked: true });
    if (!pending.length) return "empty" as const;

    const canonical: { fo: (typeof pending)[number]; order: CanonicalFulfillmentOrder }[] = [];
    for (const fo of pending) {
      const built = await canonicalOrder(tx, fo, fc.manufacturerId);
      if ("missing" in built) {
        await flagForReview(tx, {
          orgId: fo.orgId,
          type: "failed_fulfillment",
          entityType: "fulfillment_order",
          entityId: fo.id,
        });
        continue;
      }
      canonical.push({ fo, order: built });
    }
    if (!canonical.length) return "empty" as const;

    const [batch] = await tx
      .insert(dispatchBatches)
      .values({ fulfillmentCenterId: fc.id, adapterKey: fc.adapterKey, exportedBy: adminUserId })
      .returning();

    const provider = fulfillmentProvider(fc.adapterKey);
    const result = await provider.submitBatch(
      batch!.id,
      canonical.map((c) => c.order),
    );
    const file = result.artifact
      ? await storePlatformAsset(tx, {
          kind: "document",
          mime: result.artifact.mime,
          data: result.artifact.data,
          path: `dispatch/${batch!.id}/${result.artifact.filename}`,
        })
      : null;
    const accepted = new Map(result.accepted.map((a) => [a.reference, a.externalId]));

    for (const [i, { fo, order }] of canonical.entries()) {
      if (!accepted.has(order.reference)) continue;
      await tx
        .update(fulfillmentOrders)
        .set({
          dispatchBatchId: batch!.id,
          dispatchRow: i + 1,
          status: "exported",
          submittedAt: new Date(),
          externalFulfillmentId: accepted.get(order.reference) ?? null,
          requestSnapshot: { ...(fo.requestSnapshot as FoSnapshot), canonical: order },
          attempts: sql`${fulfillmentOrders.attempts} + 1`,
        })
        .where(eq(fulfillmentOrders.id, fo.id));
      await tx.insert(orderEvents).values({
        orgId: fo.orgId,
        orderId: fo.orderId,
        type: "dispatched_in_batch",
        actorType: "admin",
        actorId: adminUserId,
        payload: { dispatchBatchId: batch!.id, fulfillmentOrderId: fo.id, row: i + 1 },
      });
    }
    const [updated] = await tx
      .update(dispatchBatches)
      .set({
        status: "exported",
        fileAssetId: file?.id ?? null,
        rowCount: accepted.size,
        exportedAt: new Date(),
      })
      .where(eq(dispatchBatches.id, batch!.id))
      .returning();
    const orgs = [...new Set(canonical.map((c) => c.fo.orgId))];
    for (const orgId of [null, ...orgs])
      await tx.insert(auditLogs).values({
        orgId,
        actorUserId: adminUserId,
        actorType: "admin",
        action: "admin.dispatch_batch_exported",
        entityType: "dispatch_batch",
        entityId: batch!.id,
        after: {
          fulfillmentCenterId: fc.id,
          fulfillmentOrders: canonical
            .filter((c) => c.fo.orgId === orgId || !orgId)
            .map((c) => c.fo.id),
        },
      });
    return updated!;
  });
}

async function canonicalOrder(
  tx: Tx,
  fo: typeof fulfillmentOrders.$inferSelect,
  manufacturerId: string | null,
): Promise<CanonicalFulfillmentOrder | { missing: string }> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, fo.orderId));
  const [brand] = await tx.select().from(brands).where(eq(brands.id, order!.brandId));
  const itemIds = (fo.requestSnapshot as FoSnapshot).itemIds;
  const items = await tx
    .select({
      id: orderItems.id,
      quantity: orderItems.quantity,
      sku: skus.sku,
      skuId: skus.id,
      labelVersion: labels.version,
      printFileAssetId: labels.printFileAssetId,
    })
    .from(orderItems)
    .innerJoin(skus, eq(skus.id, orderItems.skuId))
    .leftJoin(labels, eq(labels.id, orderItems.labelId))
    .where(inArray(orderItems.id, itemIds))
    .orderBy(asc(orderItems.id));
  const mappings = manufacturerId
    ? await tx
        .select()
        .from(partnerSkuMappings)
        .where(
          and(
            eq(partnerSkuMappings.manufacturerId, manufacturerId),
            inArray(
              partnerSkuMappings.skuId,
              items.map((i) => i.skuId),
            ),
          ),
        )
    : [];
  const partnerSku = new Map(mappings.map((m) => [m.skuId, m.partnerSkuCode]));
  const lines: CanonicalFulfillmentOrder["lines"] = [];
  for (const item of items) {
    const code = partnerSku.get(item.skuId);
    if (!code) return { missing: `partner SKU for ${item.sku}` };
    let artworkUrl: string | null = null;
    if (item.printFileAssetId) {
      const [asset] = await tx.select().from(assets).where(eq(assets.id, item.printFileAssetId));
      if (asset) artworkUrl = await signedUrlForAsset(asset, ARTWORK_URL_TTL_SECONDS);
    }
    lines.push({
      sku: item.sku,
      partnerSku: code,
      quantity: item.quantity,
      artworkUrl,
      labelVersion: item.labelVersion,
    });
  }
  const ship = (order!.shipTo ?? {}) as Partial<ShipTo>;
  return {
    reference: fo.idempotencyKey,
    orderNumber: order!.externalOrderNumber,
    brandName: brand!.name,
    shipTo: {
      name: ship.name ?? null,
      company: ship.company ?? null,
      address1: ship.address1 ?? null,
      address2: ship.address2 ?? null,
      city: ship.city ?? null,
      province: ship.province ?? null,
      zip: ship.zip ?? null,
      countryCode: ship.countryCode ?? null,
      phone: ship.phone ?? null,
    },
    lines,
  };
}

export async function getBatch(batchId: string) {
  const [batch] = await privilegedDb()
    .select()
    .from(dispatchBatches)
    .where(eq(dispatchBatches.id, batchId));
  return batch ?? null;
}

export async function listBatches(limit = 100) {
  return privilegedDb()
    .select()
    .from(dispatchBatches)
    .orderBy(sql`${dispatchBatches.createdAt} desc`)
    .limit(limit);
}

export async function batchFile(batchId: string) {
  const batch = await getBatch(batchId);
  if (!batch?.fileAssetId) return null;
  const [asset] = await privilegedDb()
    .select()
    .from(assets)
    .where(eq(assets.id, batch.fileAssetId));
  return asset ? { batch, asset } : null;
}

export async function batchFulfillmentOrder(batchId: string, reference: string) {
  const [fo] = await privilegedDb()
    .select({ id: fulfillmentOrders.id, orgId: fulfillmentOrders.orgId })
    .from(fulfillmentOrders)
    .where(
      and(
        eq(fulfillmentOrders.dispatchBatchId, batchId),
        eq(fulfillmentOrders.idempotencyKey, reference),
      ),
    );
  return fo ?? null;
}

export async function settleBatch(adminUserId: string, batchId: string, report: unknown) {
  await privilegedDb().transaction(async (tx) => {
    const members = await tx
      .select({ status: fulfillmentOrders.status })
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.dispatchBatchId, batchId));
    const done = members.every((m) => m.status === "shipped" || m.status === "cancelled");
    await tx
      .update(dispatchBatches)
      .set({ status: done ? "completed" : "partially_imported", importedAt: new Date() })
      .where(eq(dispatchBatches.id, batchId));
    await tx.insert(auditLogs).values({
      orgId: null,
      actorUserId: adminUserId,
      actorType: "admin",
      action: "admin.dispatch_batch_imported",
      entityType: "dispatch_batch",
      entityId: batchId,
      after: report as object,
    });
  });
}

export const STUCK_THRESHOLDS = {
  awaitingPaymentHours: 72,
  needsReviewHours: 24,
  pendingDispatchHours: 24,
  exportedNoUpdateHours: 5 * 24,
  shippedNotPushedHours: 2,
} as const;

const hoursAgo = (now: Date, h: number) => new Date(now.getTime() - h * 3600_000);

/** Stuck-entity monitor: one open review item per stuck entity (partial unique index dedupes). */
export async function scanStuckOrders(now = new Date()) {
  const db = privilegedDb();
  const t = STUCK_THRESHOLDS;
  return db.transaction(async (tx) => {
    const counts = {
      awaitingPayment: 0,
      needsReview: 0,
      pendingDispatch: 0,
      exportedStale: 0,
      notPushed: 0,
    };
    const flag = async (
      key: keyof typeof counts,
      rows: { id: string; orgId: string }[],
      type: "failed_fulfillment" | "payment_hold",
      entityType: string,
    ) => {
      for (const r of rows) {
        await flagForReview(tx, { orgId: r.orgId, type, entityType, entityId: r.id });
        counts[key]++;
      }
    };
    const stuckOrders = (status: "awaiting_payment" | "needs_review" | "on_hold", hours: number) =>
      tx
        .select({ id: orders.id, orgId: orders.orgId })
        .from(orders)
        .where(and(eq(orders.status, status), lt(orders.updatedAt, hoursAgo(now, hours))));
    await flag(
      "awaitingPayment",
      await stuckOrders("awaiting_payment", t.awaitingPaymentHours),
      "payment_hold",
      "order",
    );
    await flag(
      "needsReview",
      await stuckOrders("needs_review", t.needsReviewHours),
      "failed_fulfillment",
      "order",
    );
    await flag(
      "needsReview",
      await stuckOrders("on_hold", t.needsReviewHours),
      "failed_fulfillment",
      "order",
    );
    await flag(
      "pendingDispatch",
      await tx
        .select({ id: fulfillmentOrders.id, orgId: fulfillmentOrders.orgId })
        .from(fulfillmentOrders)
        .where(
          and(
            eq(fulfillmentOrders.status, "pending"),
            lt(fulfillmentOrders.createdAt, hoursAgo(now, t.pendingDispatchHours)),
          ),
        ),
      "failed_fulfillment",
      "fulfillment_order",
    );
    await flag(
      "exportedStale",
      await tx
        .select({ id: fulfillmentOrders.id, orgId: fulfillmentOrders.orgId })
        .from(fulfillmentOrders)
        .where(
          and(
            inArray(fulfillmentOrders.status, [
              "exported",
              "submitted",
              "accepted",
              "in_production",
              "packed",
            ]),
            lt(fulfillmentOrders.updatedAt, hoursAgo(now, t.exportedNoUpdateHours)),
          ),
        ),
      "failed_fulfillment",
      "fulfillment_order",
    );
    await flag(
      "notPushed",
      await tx
        .select({ id: shipments.id, orgId: shipments.orgId })
        .from(shipments)
        .where(
          and(
            isNull(shipments.pushedToStoreAt),
            lt(shipments.createdAt, hoursAgo(now, t.shippedNotPushedHours)),
          ),
        ),
      "failed_fulfillment",
      "shipment",
    );
    return counts;
  });
}

export const STUCK_SCAN_JOB = "fulfillment.stuck_scan";

export async function scheduleStuckScan(now = new Date()) {
  const bucket = Math.floor(now.getTime() / 3600_000);
  const rows = await privilegedDb()
    .insert(jobQueue)
    .values({ kind: STUCK_SCAN_JOB, dedupeKey: `stuck-scan:${bucket}` })
    .onConflictDoNothing()
    .returning({ id: jobQueue.id });
  return rows.length;
}
