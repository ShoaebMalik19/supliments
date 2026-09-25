import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import {
  brandProducts,
  brandProductVariants,
  charges,
  customers,
  jobQueue,
  labels,
  ledgerEntries,
  orderEvents,
  orderItems,
  orders,
  reviewQueueItems,
  skuCosts,
  skus,
} from "@/db/schema";
import { allocateFulfillmentFee, orderBilling } from "@/modules/billing";
import {
  getOrder,
  ingestExternalOrder,
  paidOrdersAwaitingSubmission,
  recordOrderPayment,
  resolveOrder,
} from "@/modules/orders";
import { TEST_FEE_RULES, ensureFeeSchedule, seedCatalogProduct } from "./helpers";
import { seedFulfillmentCenter } from "./admin-routes";
import {
  approveLabel,
  externalOrder,
  ingestStandardOrder,
  line,
  mapVariant,
  orderReadyTenant,
  type OrderTenant,
} from "./order-fixtures";
import { feeRulesSchema } from "@/modules/pricing";

const db = () => privilegedDb();
const target = (t: OrderTenant) => ({ orgId: t.org.id, integrationId: t.integration.id });

async function rowsFor(orderId: string) {
  const [order] = await db().select().from(orders).where(eq(orders.id, orderId));
  const items = await db().select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const chargeRows = await db().select().from(charges).where(eq(charges.orderId, orderId));
  const ledger = await db().select().from(ledgerEntries).where(eq(ledgerEntries.orderId, orderId));
  const events = await db().select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
  const reviews = await db()
    .select()
    .from(reviewQueueItems)
    .where(eq(reviewQueueItems.entityId, orderId));
  return { order: order!, items, charges: chargeRows, ledger, events, reviews };
}

const sum = (xs: { amountMinor: bigint }[]) => xs.reduce((s, x) => s + x.amountMinor, 0n);
const created = (res: Awaited<ReturnType<typeof ingestExternalOrder>>) => {
  if (res.outcome === "ignored") throw new Error(`ignored: ${res.reason}`);
  return res;
};

let T: OrderTenant;
beforeAll(async () => {
  T = await orderReadyTenant();
});

describe("ingest + pricing", () => {
  it("prices a paid order into one pending_external charge and exact ledger lines", async () => {
    const res = created((await ingestStandardOrder(T)).res);
    expect(res).toMatchObject({ outcome: "created", status: "awaiting_payment" });
    const r = await rowsFor(res.orderId);
    const fee = await ensureFeeSchedule();
    // cogs 2×850+1400=3100; fee 250+3×75=475; shipping 499+2×99=697; markup 15% of 3100=465
    expect(r.charges).toHaveLength(1);
    expect(r.charges[0]).toMatchObject({
      kind: "order",
      status: "pending_external",
      provider: "manual",
      amountMinor: 4737n,
      currency: "USD",
      idempotencyKey: `order:${res.orderId}`,
      feeScheduleId: fee.id,
    });
    const byAccount = Object.fromEntries(r.ledger.map((e) => [e.account, e.amountMinor]));
    expect(byAccount).toEqual({
      cogs: 3100n,
      fulfillment_fee: 475n,
      shipping: 697n,
      platform_markup: 465n,
    });
    expect(sum(r.ledger)).toBe(r.charges[0]!.amountMinor);
    expect(
      r.ledger.every((e) => e.chargeId === r.charges[0]!.id && e.feeScheduleId === fee.id),
    ).toBe(true);
    const bySku = new Map(r.items.map((i) => [i.skuId, i]));
    expect(bySku.get(T.skus[0]!.id)).toMatchObject({
      quantity: 2,
      costUnitMinor: 850n,
      fulfillmentFeeMinor: 317n,
      labelId: T.label.id,
      brandProductVariantId: T.variants[0]!.id,
      retailUnitPriceMinor: 2999n,
      status: "pending",
    });
    expect(bySku.get(T.skus[1]!.id)).toMatchObject({
      costUnitMinor: 1400n,
      fulfillmentFeeMinor: 158n,
    });
    expect(r.events.map((e) => [e.type, e.fromStatus, e.toStatus])).toEqual([
      ["order_received", null, "received"],
      ["priced", "received", "awaiting_payment"],
    ]);
    expect(r.order.customerId).not.toBeNull();
  });

  it("is idempotent: the same order twice is one order and one charge", async () => {
    const { order, res } = await ingestStandardOrder(T);
    const again = await ingestExternalOrder(target(T), order);
    expect(again).toEqual({ ...created(res), outcome: "duplicate" });
    const rows = await db()
      .select()
      .from(orders)
      .where(eq(orders.externalOrderId, order.externalOrderId));
    expect(rows).toHaveLength(1);
    expect((await rowsFor(rows[0]!.id)).charges).toHaveLength(1);
  });

  it("concurrent duplicate deliveries create exactly one order and one charge", async () => {
    const order = externalOrder([line({ sku: T.skus[0]!.sku })]);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ingestExternalOrder(target(T), order)),
    );
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "duplicate")).toHaveLength(5);
    const ids = new Set(results.map((r) => created(r).orderId));
    expect(ids.size).toBe(1);
    expect((await rowsFor([...ids][0]!)).charges).toHaveLength(1);
  });

  it("ignores test orders, and creates only once paid", async () => {
    expect(await ingestStandardOrder(T, { test: true }).then((x) => x.res)).toEqual({
      outcome: "ignored",
      reason: "test_order",
    });
    const pending = externalOrder([line({ sku: T.skus[0]!.sku })], { financialStatus: "pending" });
    expect(await ingestExternalOrder(target(T), pending)).toEqual({
      outcome: "ignored",
      reason: "not_paid",
    });
    const paid = await ingestExternalOrder(target(T), { ...pending, financialStatus: "paid" });
    expect(paid).toMatchObject({ outcome: "created", status: "awaiting_payment" });
    const cancelled = externalOrder([line({ sku: T.skus[0]!.sku })], { cancelled: true });
    expect(await ingestExternalOrder(target(T), cancelled)).toEqual({
      outcome: "ignored",
      reason: "cancelled",
    });
  });

  it("rejects a payload that fails the ExternalOrder schema", async () => {
    const bad = { ...externalOrder([line({ sku: "x" })]), subtotalMinor: "12.50" };
    await expect(
      ingestExternalOrder(target(T), bad as unknown as Parameters<typeof ingestExternalOrder>[1]),
    ).rejects.toThrow(/subtotalMinor/);
  });

  it("uses the org of the target only: another org's integration is not found", async () => {
    const other = await orderReadyTenant("Other");
    await expect(
      ingestExternalOrder(
        { orgId: other.org.id, integrationId: T.integration.id },
        externalOrder([line({ sku: T.skus[0]!.sku })]),
      ),
    ).rejects.toThrow(/not in org/);
  });

  it("upserts the customer by external id within the brand", async () => {
    const t = await orderReadyTenant("Customers");
    await ingestStandardOrder(t);
    await ingestStandardOrder(t);
    const rows = await db().select().from(customers).where(eq(customers.orgId, t.org.id));
    expect(rows).toHaveLength(1);
  });
});

describe("line resolution (§9.5)", () => {
  it("a sync mapping wins over the SKU string; titles are never used", async () => {
    const t = await orderReadyTenant("Mapping");
    await mapVariant(t, t.integration.id, t.variants[1]!.id, "gid://variant/42");
    const res = created(
      await ingestExternalOrder(
        target(t),
        externalOrder([
          line({ sku: t.skus[0]!.sku, externalVariantId: "gid://variant/42" }),
          line({ sku: null, title: "BP" }),
        ]),
      ),
    );
    const r = await rowsFor(res.orderId);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      skuId: t.skus[1]!.id,
      brandProductVariantId: t.variants[1]!.id,
    });
  });

  it("skips lines that are not our catalog; only foreign lines → ignored", async () => {
    const res = created(
      await ingestExternalOrder(
        target(T),
        externalOrder([line({ sku: "TSHIRT-XL" }), line({ sku: T.skus[0]!.sku })]),
      ),
    );
    const r = await rowsFor(res.orderId);
    expect(r.items.map((i) => i.skuId)).toEqual([T.skus[0]!.id]);
    expect(r.order.status).toBe("awaiting_payment");
    expect(
      await ingestExternalOrder(
        target(T),
        externalOrder([line({ sku: "MUG" }), line({ sku: null })]),
      ),
    ).toEqual({ outcome: "ignored", reason: "no_catalog_items" });
  });

  it("our SKU that this brand does not sell → needs_review + review item, no charge", async () => {
    const { skus: foreign } = await seedCatalogProduct();
    const res = created(
      await ingestExternalOrder(
        target(T),
        externalOrder([line({ sku: T.skus[0]!.sku }), line({ sku: foreign[0]!.sku })]),
      ),
    );
    expect(res.status).toBe("needs_review");
    const r = await rowsFor(res.orderId);
    expect(r.order.holdReason).toBe("unresolved_lines");
    expect(r.charges).toEqual([]);
    expect(r.ledger).toEqual([]);
    expect(r.reviews).toMatchObject([
      { type: "failed_fulfillment", status: "open", orgId: T.org.id },
    ]);
    expect(r.items.find((i) => i.skuId === foreign[0]!.id)).toMatchObject({
      status: "needs_review",
      costUnitMinor: null,
    });
    const needsReview = r.events.find((e) => e.toStatus === "needs_review")!;
    expect(needsReview.payload).toMatchObject({
      unresolved: [{ sku: foreign[0]!.sku, reason: "sku_not_offered_by_brand" }],
    });
  });

  it("resolveOrder re-runs resolution and pricing once the brand sells the SKU", async () => {
    const t = await orderReadyTenant("Resolve");
    const { product, skus: foreign } = await seedCatalogProduct({ costs: [500n] });
    const res = created(
      await ingestExternalOrder(
        target(t),
        externalOrder([line({ sku: foreign[0]!.sku, quantity: 3 })]),
      ),
    );
    expect(res.status).toBe("needs_review");
    const actor = { actorType: "admin" as const, actorId: t.owner.id };
    expect(await withTenant(t.org.id, (x) => resolveOrder(x, actor, res.orderId))).toBe(
      "needs_review",
    );
    expect((await rowsFor(res.orderId)).reviews).toHaveLength(1);

    const [bp] = await db()
      .insert(brandProducts)
      .values({
        orgId: t.org.id,
        brandId: t.brand.id,
        catalogProductId: product.id,
        title: "New",
        retailPriceMinor: 1999n,
        currency: "USD",
      })
      .returning();
    await db().insert(brandProductVariants).values({
      orgId: t.org.id,
      brandProductId: bp!.id,
      skuId: foreign[0]!.id,
      retailPriceMinor: 1999n,
      currency: "USD",
    });
    expect(await withTenant(t.org.id, (x) => resolveOrder(x, actor, res.orderId))).toBe(
      "needs_review",
    );
    expect((await rowsFor(res.orderId)).order.holdReason).toBe("unresolved_lines");

    await approveLabel(t, bp!.id);
    expect(await withTenant(t.org.id, (x) => resolveOrder(x, actor, res.orderId))).toBe(
      "awaiting_payment",
    );
    const r = await rowsFor(res.orderId);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ costUnitMinor: 500n, status: "pending" });
    expect(r.charges).toHaveLength(1);
    expect(sum(r.ledger)).toBe(r.charges[0]!.amountMinor);
    expect(r.order.holdReason).toBeNull();
    await expect(
      withTenant(t.org.id, (x) => resolveOrder(x, actor, res.orderId)),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("a brand product without an approved label is unresolved", async () => {
    const t = await orderReadyTenant("NoLabel");
    await db().update(labels).set({ status: "superseded" }).where(eq(labels.id, t.label.id));
    const res = created(await ingestStandardOrder(t).then((x) => x.res));
    expect(res.status).toBe("needs_review");
    const ev = (await rowsFor(res.orderId)).events.find((e) => e.toStatus === "needs_review")!;
    expect(ev.payload).toMatchObject({ unresolved: [{ reason: "no_approved_label" }, {}] });
  });

  it("the latest approved label version is used", async () => {
    const t = await orderReadyTenant("Labels");
    const v2 = await approveLabel(t, t.brandProduct.id, 2);
    const res = created(await ingestStandardOrder(t).then((x) => x.res));
    const r = await rowsFor(res.orderId);
    expect(r.items.every((i) => i.labelId === v2.id)).toBe(true);
  });

  it("an order in another currency than our costs → needs_review, nothing priced", async () => {
    const res = created((await ingestStandardOrder(T, { currency: "EUR" })).res);
    expect(res.status).toBe("needs_review");
    const r = await rowsFor(res.orderId);
    expect(r.charges).toEqual([]);
    expect(r.items.every((i) => i.costUnitMinor === null && i.currency === "EUR")).toBe(true);
  });

  it("cost comes from sku_costs of the default fulfillment centre in force at placedAt", async () => {
    const t = await orderReadyTenant("Costs");
    const fc = await seedFulfillmentCenter();
    const skuId = t.skus[0]!.id;
    await db().update(skus).set({ defaultFulfillmentCenterId: fc }).where(eq(skus.id, skuId));
    const otherFc = await seedFulfillmentCenter();
    await db()
      .insert(skuCosts)
      .values([
        {
          skuId,
          fulfillmentCenterId: fc,
          costMinor: 700n,
          currency: "USD",
          effectiveFrom: new Date("2020-01-01"),
          effectiveTo: new Date("2026-01-01"),
        },
        {
          skuId,
          fulfillmentCenterId: fc,
          costMinor: 900n,
          currency: "USD",
          effectiveFrom: new Date("2026-01-01"),
        },
        {
          skuId,
          fulfillmentCenterId: otherFc,
          costMinor: 1n,
          currency: "USD",
          effectiveFrom: new Date("2020-01-01"),
        },
      ]);
    const cost = async (placedAt: Date) => {
      const res = created(
        await ingestExternalOrder(
          target(t),
          externalOrder([line({ sku: t.skus[0]!.sku })], { placedAt }),
        ),
      );
      return (await rowsFor(res.orderId)).items[0]!.costUnitMinor;
    };
    expect(await cost(new Date("2025-06-01"))).toBe(700n);
    expect(await cost(new Date("2026-06-01"))).toBe(900n);
    const noFc = created(
      await ingestExternalOrder(target(t), externalOrder([line({ sku: t.skus[1]!.sku })])),
    );
    expect((await rowsFor(noFc.orderId)).items[0]!.costUnitMinor).toBe(1400n);
  });
});

describe("upstream cancellation", () => {
  it("before submitted: cancels ours and voids the unpaid charge (ledger balance 0)", async () => {
    const { order, res } = await ingestStandardOrder(T);
    const out = await ingestExternalOrder(target(T), { ...order, cancelled: true });
    expect(out).toMatchObject({ outcome: "updated", status: "cancelled" });
    const r = await rowsFor(created(res).orderId);
    expect(r.order.status).toBe("cancelled");
    expect(r.charges[0]).toMatchObject({ status: "failed", failureCode: "order_cancelled" });
    expect(sum(r.ledger)).toBe(0n);
    expect(await ingestExternalOrder(target(T), { ...order, cancelled: true })).toMatchObject({
      outcome: "duplicate",
      status: "cancelled",
    });
  });

  it("after submitted: status unchanged, one review item, repeat is a no-op", async () => {
    const { order, res } = await ingestStandardOrder(T);
    const id = created(res).orderId;
    await db().update(orders).set({ status: "submitted" }).where(eq(orders.id, id));
    const out = await ingestExternalOrder(target(T), { ...order, cancelled: true });
    expect(out).toMatchObject({ outcome: "updated", status: "submitted" });
    expect(await ingestExternalOrder(target(T), { ...order, cancelled: true })).toMatchObject({
      outcome: "duplicate",
    });
    const r = await rowsFor(id);
    expect(r.reviews).toMatchObject([{ type: "failed_fulfillment", status: "open" }]);
    expect(r.events.filter((e) => e.type === "upstream_cancel_requested")).toHaveLength(1);
  });
});

describe("payment (manual provider)", () => {
  const admin = () => ({ userId: T.owner.id });

  it("mark paid: charge succeeded, ledger balance 0, event, audit, job; idempotent", async () => {
    const id = created((await ingestStandardOrder(T)).res).orderId;
    const pay = () =>
      withTenant(T.org.id, (t) =>
        recordOrderPayment(t, admin(), id, { reference: "BANK-1", note: null }),
      );
    const first = await pay();
    expect(first).toMatchObject({ alreadyPaid: false, charge: { status: "succeeded" } });
    const second = await pay();
    expect(second).toMatchObject({ alreadyPaid: true });

    const r = await rowsFor(id);
    expect(r.order.status).toBe("awaiting_payment");
    expect(r.charges[0]).toMatchObject({
      status: "succeeded",
      markedPaidBy: T.owner.id,
      providerPaymentIntentId: "manual:BANK-1",
    });
    expect(r.charges[0]!.markedPaidAt).not.toBeNull();
    const payments = r.ledger.filter((e) => e.account === "payment");
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amountMinor).toBe(-4737n);
    expect(sum(r.ledger)).toBe(0n);
    expect(r.events.filter((e) => e.type === "payment_recorded")).toHaveLength(1);
    const jobs = await db()
      .select()
      .from(jobQueue)
      .where(and(eq(jobQueue.kind, "fulfillment.order_paid"), eq(jobQueue.orgId, T.org.id)));
    expect(jobs.filter((j) => (j.payload as { orderId: string }).orderId === id)).toHaveLength(1);
    const ready = await withTenant(T.org.id, (t) => paidOrdersAwaitingSubmission(t));
    expect(ready.map((o) => o.id)).toContain(id);
    const detail = await withTenant(T.org.id, (t) => getOrder(t, id));
    expect(detail!.ledger.balanceMinor).toBe(0n);
  });

  it("concurrent mark-paid records exactly one payment", async () => {
    const id = created((await ingestStandardOrder(T)).res).orderId;
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        withTenant(T.org.id, (t) =>
          recordOrderPayment(t, admin(), id, { reference: `R${i}`, note: null }),
        ),
      ),
    );
    expect(results.filter((r) => r && !r.alreadyPaid)).toHaveLength(1);
    const r = await rowsFor(id);
    expect(r.ledger.filter((e) => e.account === "payment")).toHaveLength(1);
    expect(sum(r.ledger)).toBe(0n);
  });

  it("a needs_review or cancelled order cannot be marked paid", async () => {
    const { order, res } = await ingestStandardOrder(T);
    await ingestExternalOrder(target(T), { ...order, cancelled: true });
    await expect(
      withTenant(T.org.id, (t) =>
        recordOrderPayment(t, admin(), created(res).orderId, { reference: "x", note: null }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("money invariants", () => {
  it("fulfillment fee allocation always sums exactly to the order fee", () => {
    const rules = feeRulesSchema.parse({ ...TEST_FEE_RULES, perOrderFulfillmentFeeMinor: 1001 });
    for (let n = 1; n <= 7; n++) {
      const lines = Array.from({ length: n }, (_, i) => ({
        itemId: `i${i}`,
        quantity: ((i * 7) % 5) + 1,
        unitCostMinor: 1n,
      }));
      const fees = allocateFulfillmentFee(rules, lines);
      const units = lines.reduce((s, l) => s + BigInt(l.quantity), 0n);
      expect([...fees.values()].reduce((a, b) => a + b, 0n)).toBe(
        rules.perOrderFulfillmentFeeMinor + rules.perUnitFulfillmentFeeMinor * units,
      );
    }
  });

  it("ledger sum equals the charge before payment for every priced order in the org", async () => {
    const priced = await db()
      .select()
      .from(charges)
      .where(and(eq(charges.orgId, T.org.id), eq(charges.status, "pending_external")));
    expect(priced.length).toBeGreaterThan(0);
    for (const c of priced) {
      const b = await withTenant(T.org.id, (t) => orderBilling(t, c.orderId!));
      expect(b.summary.balanceMinor).toBe(c.amountMinor);
    }
  });
});
