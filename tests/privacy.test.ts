import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import {
  assets,
  customers,
  fulfillmentOrders,
  jobQueue,
  orders,
  outboxEvents,
  reviewQueueItems,
  webhookEvents,
} from "@/db/schema";
import { setShopifyFetchForTests } from "@/adapters/shopify";
import { setStorageProviderForTests } from "@/modules/assets";
import { drainUntilEmpty } from "@/modules/jobs";
import { ingestExternalOrder } from "@/modules/orders";
import { renderEmail, templateFor } from "@/modules/notifications";
import { registerAllJobs } from "@/queue";
import * as webhookRoute from "@/app/api/webhooks/shopify/route";
import { FakeShopify } from "./fake-shopify";
import { fakeStorage } from "./fake-storage";
import { createTenant, ensureFeeSchedule, seedBrandProduct } from "./helpers";
import { approveLabel, externalOrder, line } from "./order-fixtures";
import { seedShopifyIntegration } from "./shopify-helpers";
import { seedCenter } from "./fulfillment-fixtures";

const fake = new FakeShopify();
const db = () => privilegedDb();

beforeAll(() => {
  setShopifyFetchForTests(fake.fetch);
  setStorageProviderForTests(fakeStorage);
  registerAllJobs();
});
afterAll(async () => {
  await db()
    .delete(jobQueue)
    .where(sql`${jobQueue.kind} like 'integrations.privacy%'`);
  setShopifyFetchForTests(null);
  setStorageProviderForTests(null);
});

const BUYER = {
  externalId: "7001",
  email: "Ada.Buyer@Example.com",
  name: "Ada Buyer",
  phone: "+15125550100",
};
const ADDRESS = {
  name: "Ada Buyer",
  address1: "1 Main St",
  city: "Austin",
  zip: "78701",
  countryCode: "US",
};

async function storeWithOrders() {
  await ensureFeeSchedule();
  const tenant = await createTenant("Privacy");
  const bp = await seedBrandProduct(tenant);
  await approveLabel(tenant, bp.brandProduct.id);
  const shop = `privacy-${randomUUID().slice(0, 8)}.myshopify.com`;
  const { integration } = await seedShopifyIntegration(fake, tenant, shop);
  const place = async (externalOrderId: string, customer = BUYER) => {
    const r = await ingestExternalOrder(
      { orgId: tenant.org.id, integrationId: integration.id },
      externalOrder([line({ sku: bp.skus[0]!.sku })], {
        externalOrderId,
        customer: {
          externalId: customer.externalId,
          email: customer.email,
          name: customer.name,
          phone: customer.phone,
        },
        shipTo: ADDRESS,
        billTo: ADDRESS,
      }),
    );
    if (r.outcome !== "created") throw new Error("seed order failed");
    await db()
      .insert(webhookEvents)
      .values({
        provider: "shopify",
        integrationId: integration.id,
        topic: "orders/paid",
        externalEventId: `seed-${externalOrderId}`,
        payload: {
          id: Number(externalOrderId),
          email: customer.email,
          customer: { id: Number(customer.externalId), email: customer.email },
          shipping_address: ADDRESS,
        },
        signatureValid: true,
        status: "processed",
        dedupeKey: `shopify:seed-${externalOrderId}-${randomUUID()}`,
      });
    return r.orderId;
  };
  return { tenant, shop, integration, place };
}

const setStatus = (id: string, status: "delivered" | "awaiting_payment") =>
  db().update(orders).set({ status }).where(eq(orders.id, id));
const orderRow = async (id: string) =>
  (await db().select().from(orders).where(eq(orders.id, id)))[0]!;

async function deliver(topic: string, shop: string, payload: object) {
  const res = await webhookRoute.POST(
    fake.webhookRequest({ topic, shop, payload, eventId: randomUUID() }),
  );
  expect(res.status).toBe(200);
  await drainUntilEmpty({ budgetMs: 20_000 });
}

const leaksBuyer = (v: unknown) => /Ada|1 Main St|5550100|example\.com/i.test(JSON.stringify(v));

describe("customers/redact", () => {
  it("redacts shipped orders now, defers in-flight ones, and finishes on retry", async () => {
    const { tenant, shop, integration, place } = await storeWithOrders();
    const shipped = await place("9001");
    const inFlight = await place("9002");
    const otherBuyer = await place("9003", {
      ...BUYER,
      externalId: "7002",
      email: "bob@example.org",
      name: "Bob",
      phone: null as unknown as string,
    });
    await setStatus(shipped, "delivered");
    await setStatus(otherBuyer, "delivered");

    await deliver("customers/redact", shop, {
      shop_id: 1,
      shop_domain: shop,
      customer: { id: 7001, email: BUYER.email, phone: BUYER.phone },
      orders_to_redact: [9001, 9002],
    });

    const s = await orderRow(shipped);
    expect(s.shipTo).toEqual({ redacted: true, countryCode: "US" });
    expect(s.billTo).toEqual({ redacted: true, countryCode: "US" });
    expect((await orderRow(inFlight)).shipTo).toMatchObject({ address1: "1 Main St" });
    expect((await orderRow(otherBuyer)).shipTo).toMatchObject({ name: "Ada Buyer" });
    const [ada] = await db()
      .select()
      .from(customers)
      .where(and(eq(customers.orgId, tenant.org.id), eq(customers.externalCustomerId, "7001")));
    expect(ada!.email).toBe(BUYER.email);

    const [ev] = await db()
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.integrationId, integration.id),
          eq(webhookEvents.topic, "customers/redact"),
        ),
      );
    expect(ev).toMatchObject({
      status: "received",
      error: expect.stringContaining("deferred: 1 order"),
    });
    const retry = await db()
      .select()
      .from(jobQueue)
      .where(eq(jobQueue.kind, "integrations.privacy_retry"));
    const mine = retry.filter(
      (j) => (j.payload as { webhookEventId: string }).webhookEventId === ev!.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.runAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);

    await setStatus(inFlight, "delivered");
    await db().update(jobQueue).set({ runAt: new Date() }).where(eq(jobQueue.id, mine[0]!.id));
    await drainUntilEmpty({ budgetMs: 20_000 });

    expect((await orderRow(inFlight)).shipTo).toEqual({ redacted: true, countryCode: "US" });
    const [after] = await db()
      .select()
      .from(customers)
      .where(and(eq(customers.orgId, tenant.org.id), eq(customers.externalCustomerId, "7001")));
    expect(after).toMatchObject({ email: null, phone: null, name: null });
    const events = await db()
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.integrationId, integration.id));
    const adaEvents = events.filter(
      (e) =>
        e.externalEventId === "seed-9001" ||
        e.externalEventId === "seed-9002" ||
        e.topic === "customers/redact",
    );
    expect(adaEvents.every((e) => !leaksBuyer(e.payload))).toBe(true);
    expect(events.find((e) => e.topic === "customers/redact")!.status).toBe("processed");
    expect(leaksBuyer(events.find((e) => e.externalEventId === "seed-9003")!.payload)).toBe(true);
  });

  it("redacts the fulfillment snapshot's copy of the address", async () => {
    const { tenant, shop, place } = await storeWithOrders();
    const orderId = await place("9101");
    await setStatus(orderId, "delivered");
    const fcId = (await seedCenter()).id;
    await db()
      .insert(fulfillmentOrders)
      .values({
        orgId: tenant.org.id,
        orderId,
        fulfillmentCenterId: fcId,
        adapterKey: "manual",
        idempotencyKey: `fo:${orderId}:${fcId}`,
        status: "shipped",
        requestSnapshot: { itemIds: [], canonical: { reference: "r", shipTo: ADDRESS } },
      });
    await deliver("customers/redact", shop, {
      shop_domain: shop,
      customer: { id: 7001, email: BUYER.email },
      orders_to_redact: [9101],
    });
    const [fo] = await db()
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.orderId, orderId));
    expect((fo!.requestSnapshot as { canonical: { shipTo: unknown } }).canonical.shipTo).toEqual({
      redacted: true,
    });
    expect(leaksBuyer(fo!.requestSnapshot)).toBe(false);
  });
});

describe("customers/data_request", () => {
  it("exports what we hold to a private org file, emails the owners, and sets a 30-day review item", async () => {
    const { tenant, shop, place } = await storeWithOrders();
    await place("9201");
    await place("9202", {
      ...BUYER,
      externalId: "7002",
      email: "bob@example.org",
      name: "Bob",
      phone: null as unknown as string,
    });
    await deliver("customers/data_request", shop, {
      shop_id: 1,
      shop_domain: shop,
      orders_requested: [9201],
      customer: { id: 7001, email: BUYER.email, phone: BUYER.phone },
      data_request: { id: 555 },
    });

    const [asset] = await db()
      .select()
      .from(assets)
      .where(and(eq(assets.orgId, tenant.org.id), eq(assets.kind, "document")));
    expect(asset).toMatchObject({ mime: "application/json", uploadStatus: "ready" });
    expect(asset!.storageKey.startsWith(`org/${tenant.org.id}/`)).toBe(true);
    const doc = JSON.parse(
      new TextDecoder().decode((await fakeStorage.getObject(asset!.bucket, asset!.storageKey))!),
    );
    expect(doc).toMatchObject({ kind: "customer_data_export", shop, requestId: "555" });
    expect(doc.customers).toEqual([
      expect.objectContaining({ email: BUYER.email, externalCustomerId: "7001" }),
    ]);
    expect(doc.orders.map((o: { externalOrderId: string }) => o.externalOrderId)).toEqual(["9201"]);
    expect(JSON.stringify(doc)).not.toContain("bob@example.org");

    const [item] = await db()
      .select()
      .from(reviewQueueItems)
      .where(
        and(eq(reviewQueueItems.entityId, asset!.id), eq(reviewQueueItems.type, "privacy_request")),
      );
    expect(item!.dueAt!.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);

    const [ev] = await db()
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.orgId, tenant.org.id),
          eq(outboxEvents.eventType, "privacy.data_request"),
        ),
      );
    const template = templateFor(ev!);
    expect(template).toBe("privacy_data_request");
    const mail = renderEmail(template!, ev!.payload, "https://app.test");
    expect(mail.text).toContain(`https://app.test/api/assets/${asset!.id}/url?redirect=1`);
    expect(leaksBuyer(ev!.payload)).toBe(false);

    const [req] = await db()
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.topic, "customers/data_request"));
    expect(req!.status).toBe("processed");
    expect(leaksBuyer(req!.payload)).toBe(false);
  });
});

describe("shop/redact", () => {
  it("redacts everything from that store only — another store of the same org and other orgs are untouched", async () => {
    const { tenant, shop, place } = await storeWithOrders();
    const a = await place("9301");
    await setStatus(a, "delivered");
    const otherShop = `privacy-other-${randomUUID().slice(0, 6)}.myshopify.com`;
    const second = await seedShopifyIntegration(fake, tenant, otherShop);
    const bp = await seedBrandProduct(tenant);
    await approveLabel(tenant, bp.brandProduct.id);
    const r = await ingestExternalOrder(
      { orgId: tenant.org.id, integrationId: second.integration.id },
      externalOrder([line({ sku: bp.skus[0]!.sku })], {
        externalOrderId: "9302",
        shipTo: ADDRESS,
        customer: { externalId: "8001", email: "carol@example.net", name: "Carol", phone: null },
      }),
    );
    if (r.outcome !== "created") throw new Error();
    await setStatus(r.orderId, "delivered");
    const elsewhere = await storeWithOrders();
    const foreign = await elsewhere.place("9303");
    await setStatus(foreign, "delivered");

    await deliver("shop/redact", shop, { shop_id: 1, shop_domain: shop });

    expect((await orderRow(a)).shipTo).toEqual({ redacted: true, countryCode: "US" });
    expect((await orderRow(r.orderId)).shipTo).toMatchObject({ address1: "1 Main St" });
    expect((await orderRow(foreign)).shipTo).toMatchObject({ address1: "1 Main St" });
  });
});

describe("replay protection", () => {
  it("a body naming a different shop than the integration is ignored, nothing redacted", async () => {
    const victim = await storeWithOrders();
    const orderId = await victim.place("9401");
    await setStatus(orderId, "delivered");
    const attacker = await storeWithOrders();
    await deliver("shop/redact", attacker.shop, { shop_id: 1, shop_domain: victim.shop });
    expect((await orderRow(orderId)).shipTo).toMatchObject({ address1: "1 Main St" });
    const [ev] = await db()
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.integrationId, attacker.integration.id),
          eq(webhookEvents.topic, "shop/redact"),
        ),
      );
    expect(ev).toMatchObject({ status: "ignored", error: "payload shop differs from integration" });
  });

  it("works for a disconnected store (shop/redact arrives 48h after uninstall)", async () => {
    const { shop, integration, place } = await storeWithOrders();
    const orderId = await place("9501");
    await setStatus(orderId, "delivered");
    await db().execute(
      sql`update integrations set status = 'disconnected', credentials_ciphertext = null where id = ${integration.id}`,
    );
    await deliver("shop/redact", shop, { shop_domain: shop });
    expect((await orderRow(orderId)).shipTo).toEqual({ redacted: true, countryCode: "US" });
  });
});

describe("Shopify compliance topics", () => {
  it("are routed but never subscribed through the API (Shopify configures them per app)", async () => {
    const { SHOPIFY_WEBHOOK_TOPICS, shopify: shopifyCommerce } = await import("@/adapters/shopify");
    for (const t of ["customers/data_request", "customers/redact", "shop/redact"]) {
      expect(SHOPIFY_WEBHOOK_TOPICS as readonly string[]).not.toContain(t);
      expect(
        shopifyCommerce.normalizePrivacyRequest(t, {
          shop_domain: "X.myshopify.com",
          customer: {},
        }),
      ).not.toBeNull();
    }
    expect(shopifyCommerce.normalizePrivacyRequest("orders/paid", {})).toBeNull();
  });
});
