import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import {
  dispatchBatches,
  fulfillmentOrders,
  jobQueue,
  orderEvents,
  orderItems,
  orders,
  reviewQueueItems,
  shipmentItems,
  shipments,
  skus,
} from "@/db/schema";
import { parseCsv, toCsv } from "@/adapters/manual/csv";
import { EXPORT_COLUMNS } from "@/adapters/manual/fulfillment";
import { setStorageProviderForTests, readAssetObject } from "@/modules/assets";
import {
  batchFile,
  createDispatchBatch,
  importDispatchResults,
  pushShipment,
  scanStuckOrders,
  submitPaidOrder,
} from "@/modules/fulfillment";
import { fakeStorage } from "./fake-storage";
import { exportedBatch, seedCenter, submittedOrder } from "./fulfillment-fixtures";
import { ingestStandardOrder, orderReadyTenant } from "./order-fixtures";

const db = () => privilegedDb();
beforeAll(() => setStorageProviderForTests(fakeStorage));
afterAll(async () => {
  await db()
    .delete(jobQueue)
    .where(sql`${jobQueue.kind} like 'fulfillment.%'`);
  setStorageProviderForTests(null);
});

const orderRow = async (id: string) =>
  (await db().select().from(orders).where(eq(orders.id, id)))[0]!;
const fosFor = (orderId: string) =>
  db().select().from(fulfillmentOrders).where(eq(fulfillmentOrders.orderId, orderId));
const openItems = (entityId: string) =>
  db()
    .select()
    .from(reviewQueueItems)
    .where(and(eq(reviewQueueItems.entityId, entityId), eq(reviewQueueItems.status, "open")));

async function exportedRows(batchId: string) {
  const f = await batchFile(batchId);
  const text = new TextDecoder().decode((await readAssetObject(f!.asset))!);
  return parseCsv(text);
}

function completedSheet(
  rows: string[][],
  fill: (row: Record<string, string>) => Record<string, string>,
) {
  const [header, ...data] = rows;
  const out = data.map((r) => {
    const obj = Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ""]));
    const filled = { ...obj, ...fill(obj) };
    return header!.map((h) => filled[h] ?? "");
  });
  return new TextEncoder().encode(toCsv(header!, out));
}

const shipAll =
  (tracking = "1Z0001") =>
  (r: Record<string, string>) => ({
    status: "Shipped",
    carrier: "UPS",
    tracking_number: `${tracking}-${r.order_reference}`,
    shipped_at: "2026-09-20T10:00:00Z",
    lot_number: "LOT-42",
    expires_on: "2028-09-01",
  });

describe("paid order → fulfillment orders", () => {
  it("routes to the SKU's center, records the idempotency key, moves the order to submitted", async () => {
    const s = await submittedOrder();
    const fos = await fosFor(s.orderId);
    expect(fos).toHaveLength(1);
    expect(fos[0]).toMatchObject({
      fulfillmentCenterId: s.fc.id,
      status: "pending",
      adapterKey: "manual",
      idempotencyKey: `fo:${s.orderId}:${s.fc.id}`,
    });
    expect((await orderRow(s.orderId)).status).toBe("submitted");
    await submitPaidOrder(s.tenant.org.id, s.orderId);
    expect(await fosFor(s.orderId)).toHaveLength(1);
  });

  it("does nothing for an unpaid order", async () => {
    const fc = await seedCenter();
    const t = await orderReadyTenant();
    await db()
      .update(skus)
      .set({ defaultFulfillmentCenterId: fc.id })
      .where(eq(skus.id, t.skus[0]!.id));
    const { res } = await ingestStandardOrder(t);
    if (res.outcome !== "created") throw new Error();
    expect(await submitPaidOrder(t.org.id, res.orderId)).toEqual({ submitted: false });
    expect((await orderRow(res.orderId)).status).toBe("awaiting_payment");
    expect(await fosFor(res.orderId)).toHaveLength(0);
  });

  it("an item routed to an inactive center sends the order to needs_review with a review item", async () => {
    const fc = await seedCenter({ active: false });
    const s = await submittedOrder({ fc });
    expect((await orderRow(s.orderId)).status).toBe("needs_review");
    expect(await openItems(s.orderId)).toHaveLength(1);
  });
});

describe("dispatch batch export", () => {
  it("exports pending orders once, with partner SKUs and a signed artwork link", async () => {
    const { batch, orderId, fc, admin } = await exportedBatch();
    expect(batch).toMatchObject({ status: "exported", rowCount: 1, fulfillmentCenterId: fc.id });
    const [header, ...rows] = await exportedRows(batch.id);
    const col = (r: string[], c: string) => r[header!.indexOf(c)];
    expect(header).toEqual([...EXPORT_COLUMNS]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => col(r, "partner_sku")).every((c) => c!.startsWith("P-"))).toBe(true);
    expect(col(rows[0]!, "order_reference")).toBe(`fo:${orderId}:${fc.id}`);
    expect(col(rows[0]!, "artwork_url")).toMatch(
      /^https:\/\/storage\.test\/download\/.*\.*ttl=604800/,
    );
    const [fo] = await fosFor(orderId);
    expect(fo).toMatchObject({ status: "exported", dispatchBatchId: batch.id, dispatchRow: 1 });
    expect(await createDispatchBatch(admin.id, fc.id)).toBe("empty");
    const events = await db().select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
    expect(events.map((e) => e.type)).toContain("dispatched_in_batch");
  });

  it("holds back an order whose SKU has no partner code and flags it", async () => {
    const s = await submittedOrder({ mapPartnerSkus: false });
    expect(await createDispatchBatch(s.admin.id, s.fc.id)).toBe("empty");
    const [fo] = await fosFor(s.orderId);
    expect(fo!.status).toBe("pending");
    expect(await openItems(fo!.id)).toHaveLength(1);
  });
});

describe("completed sheet import", () => {
  it("creates the shipment, lot data and a push job; order becomes shipped; re-import is a no-op", async () => {
    const { batch, orderId, admin } = await exportedBatch();
    const sheet = completedSheet(await exportedRows(batch.id), shipAll());
    const r1 = await importDispatchResults(admin.id, batch.id, sheet);
    expect(r1).toMatchObject({
      applied: [expect.any(String)],
      duplicates: [],
      unmatched: [],
      errors: [],
    });
    expect((await orderRow(orderId)).status).toBe("shipped");
    const [fo] = await fosFor(orderId);
    const ships = await db()
      .select()
      .from(shipments)
      .where(eq(shipments.fulfillmentOrderId, fo!.id));
    expect(ships).toHaveLength(1);
    expect(ships[0]).toMatchObject({ carrier: "UPS", lotNumber: "LOT-42" });
    const items = await db().select().from(orderItems).where(eq(orderItems.orderId, orderId));
    expect(
      items.every(
        (i) => i.status === "shipped" && i.lotNumber === "LOT-42" && i.expiresOn === "2028-09-01",
      ),
    ).toBe(true);
    const sItems = await db()
      .select()
      .from(shipmentItems)
      .where(eq(shipmentItems.shipmentId, ships[0]!.id));
    expect(sItems.reduce((n, i) => n + i.quantity, 0)).toBe(3);
    const pushJobs = await db()
      .select()
      .from(jobQueue)
      .where(eq(jobQueue.dedupeKey, `push:${ships[0]!.id}`));
    expect(pushJobs).toHaveLength(1);
    const [b] = await db().select().from(dispatchBatches).where(eq(dispatchBatches.id, batch.id));
    expect(b!.status).toBe("completed");

    const r2 = await importDispatchResults(admin.id, batch.id, sheet);
    expect(r2).toMatchObject({ applied: [], duplicates: [expect.any(String)] });
    expect(
      await db().select().from(shipments).where(eq(shipments.fulfillmentOrderId, fo!.id)),
    ).toHaveLength(1);
  });

  it("a reference from another batch (another tenant) is reported unmatched and untouched", async () => {
    const one = await exportedBatch();
    const two = await exportedBatch();
    const foreign = completedSheet(await exportedRows(two.batch.id), shipAll("1ZX"));
    const report = await importDispatchResults(one.admin.id, one.batch.id, foreign);
    expect(report!.unmatched).toHaveLength(1);
    expect(report!.applied).toEqual([]);
    expect((await orderRow(two.orderId)).status).toBe("submitted");
  });

  it("walks progress statuses forward only, and flags unknown partner statuses", async () => {
    const { batch, orderId, admin } = await exportedBatch();
    const rows = await exportedRows(batch.id);
    await importDispatchResults(
      admin.id,
      batch.id,
      completedSheet(rows, () => ({ status: "In Production" })),
    );
    expect((await orderRow(orderId)).status).toBe("in_production");
    const back = await importDispatchResults(
      admin.id,
      batch.id,
      completedSheet(rows, () => ({ status: "accepted" })),
    );
    expect(back!.duplicates).toHaveLength(1);
    expect((await orderRow(orderId)).status).toBe("in_production");
    const odd = await importDispatchResults(
      admin.id,
      batch.id,
      completedSheet(rows, () => ({ status: "lost at sea" })),
    );
    expect(odd!.unknownStatus).toHaveLength(1);
    const [fo] = await fosFor(orderId);
    expect(await openItems(fo!.id)).toHaveLength(1);
  });

  it("the same tracking number reported for a different order is a conflict, not a second shipment", async () => {
    const one = await exportedBatch();
    await importDispatchResults(
      one.admin.id,
      one.batch.id,
      completedSheet(await exportedRows(one.batch.id), () => ({
        status: "shipped",
        carrier: "UPS",
        tracking_number: "1ZSAME",
      })),
    );
    const two = await exportedBatch();
    const r = await importDispatchResults(
      two.admin.id,
      two.batch.id,
      completedSheet(await exportedRows(two.batch.id), () => ({
        status: "shipped",
        carrier: "UPS",
        tracking_number: "1ZSAME",
      })),
    );
    expect(r!.conflicts).toHaveLength(1);
    expect((await orderRow(two.orderId)).status).toBe("submitted");
  });
});

describe("store push", () => {
  it("an order without a store records a skip instead of failing", async () => {
    const { batch, orderId, admin, tenant } = await exportedBatch();
    await importDispatchResults(
      admin.id,
      batch.id,
      completedSheet(await exportedRows(batch.id), shipAll("1ZNS")),
    );
    await db().update(orders).set({ integrationId: null }).where(eq(orders.id, orderId));
    const [ship] = await db().select().from(shipments).where(eq(shipments.orgId, tenant.org.id));
    expect(await pushShipment(tenant.org.id, ship!.id)).toEqual({ pushed: false });
    const events = await db().select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
    expect(events.map((e) => e.type)).toContain("tracking_push_skipped");
  });

  it("a disconnected integration blocks the push without retrying and opens a review item", async () => {
    const { batch, orderId, admin, tenant } = await exportedBatch();
    await importDispatchResults(
      admin.id,
      batch.id,
      completedSheet(await exportedRows(batch.id), shipAll("1ZDC")),
    );
    const [ship] = await db().select().from(shipments).where(eq(shipments.orgId, tenant.org.id));
    expect(await pushShipment(tenant.org.id, ship!.id)).toEqual({ pushed: false });
    const events = await db().select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
    expect(events.map((e) => e.type)).toContain("tracking_push_blocked");
    expect(await openItems(ship!.id)).toHaveLength(1);
  });
});

describe("stuck-order monitor", () => {
  it("flags an order stuck awaiting payment exactly once", async () => {
    const t = await orderReadyTenant();
    const { res } = await ingestStandardOrder(t);
    if (res.outcome !== "created") throw new Error();
    await db().transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx
        .update(orders)
        .set({ updatedAt: new Date(Date.now() - 100 * 3600_000) })
        .where(eq(orders.id, res.orderId));
    });
    const stale = (await orderRow(res.orderId)).updatedAt;
    expect(stale.getTime()).toBeLessThan(Date.now() - 99 * 3600_000);
    await scanStuckOrders();
    await scanStuckOrders();
    const items = await openItems(res.orderId);
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("payment_hold");
  });
});
