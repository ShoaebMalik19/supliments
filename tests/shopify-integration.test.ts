import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import {
  auditLogs,
  brandProducts,
  integrations,
  jobQueue,
  labels,
  labelTemplates,
  oauthStates,
  productSyncMappings,
  reviewQueueItems,
  stores,
  webhookEvents,
} from "@/db/schema";
import { setShopifyFetchForTests } from "@/adapters/shopify";
import { setSessionSourceForTests } from "@/modules/auth";
import { setStorageProviderForTests } from "@/modules/assets";
import { ingestExternalOrder } from "@/modules/orders";
import {
  IntegrationUnavailableError,
  pushShipmentToStore,
  registerIntegrationJobs,
  scheduleReconciliation,
} from "@/modules/integrations";
import { decryptSecret } from "@/modules/integrations/secrets";
import { drainJobs } from "@/modules/jobs";
import * as publishRoute from "@/app/api/brand-products/[id]/publish/route";
import * as webhookRoute from "@/app/api/webhooks/shopify/route";
import { FakeSession } from "./fake-session";
import { FakeShopify } from "./fake-shopify";
import { bytesOf, fakeStorage, PNG_HEADER } from "./fake-storage";
import { createAsset, createTenant, createUser, seedBrandProduct } from "./helpers";
import {
  beginInstall,
  clearIntegrationJobs,
  connectShopify,
  finishInstall,
  seedShopifyIntegration,
  uniqueShop,
} from "./shopify-helpers";

vi.mock("@/modules/orders", async (orig) => ({
  ...(await orig<typeof import("@/modules/orders")>()),
  ingestExternalOrder: vi.fn(async () => ({
    outcome: "created",
    orderId: "00000000-0000-0000-0000-000000000000",
    status: "received",
  })),
}));

const ingest = vi.mocked(ingestExternalOrder);
const session = new FakeSession();
let fake: FakeShopify;
type Tenant = Awaited<ReturnType<typeof createTenant>>;

beforeAll(() => {
  setSessionSourceForTests(session);
  setStorageProviderForTests(fakeStorage);
  registerIntegrationJobs();
});
afterAll(async () => {
  setSessionSourceForTests(null);
  setStorageProviderForTests(null);
  setShopifyFetchForTests(null);
  await clearIntegrationJobs();
});
beforeEach(() => {
  fake = new FakeShopify();
  setShopifyFetchForTests(fake.fetch);
  ingest.mockClear();
});

const db = () => privilegedDb();
const integrationRow = async (id: string) =>
  (await db().select().from(integrations).where(eq(integrations.id, id)))[0]!;
const jobsFor = async (kind: string, orgId: string) =>
  db()
    .select()
    .from(jobQueue)
    .where(and(eq(jobQueue.kind, kind), eq(jobQueue.orgId, orgId)));

async function drainIntegrationJobs() {
  for (let i = 0; i < 5; i++) {
    const s = await drainJobs({ limit: 50 });
    if (s.succeeded + s.retried + s.dead === 0) break;
  }
}

describe("OAuth connect", () => {
  let A: Tenant;
  beforeEach(async () => {
    A = await createTenant("Connect A");
  });

  it("install stores only the state hash and redirects to the shop's authorize URL", async () => {
    const shop = uniqueShop();
    session.actAs(A.owner);
    const { res, state } = await beginInstall(A, shop);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe(shop);
    expect(loc.searchParams.get("redirect_uri")).toMatch(/\/api\/integrations\/shopify\/callback$/);
    const rows = await db().select().from(oauthStates).where(eq(oauthStates.shop, shop));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: A.org.id, createdBy: A.owner.id, usedAt: null });
    expect(rows[0]!.stateHash).not.toContain(state!);
    expect(rows[0]!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("install rejects bad shop domains (400) and other tenants' brands (404)", async () => {
    const B = await createTenant("Connect B");
    session.actAs(A.owner);
    expect((await beginInstall(A, "evil.com")).res.status).toBe(400);
    expect((await beginInstall(A, uniqueShop(), B.brand.id)).res.status).toBe(404);
  });

  it("a member without org:update cannot start an install", async () => {
    const { memberships } = await import("@/db/schema");
    const user = await createUser();
    await db().insert(memberships).values({ orgId: A.org.id, userId: user.id, role: "member" });
    session.actAs(user);
    expect((await beginInstall(A, uniqueShop())).res.status).toBe(403);
  });

  it("connects: encrypted token, store row, webhooks, catch-up job, audit without the token", async () => {
    const shop = uniqueShop();
    fake.createShop(shop, { currency: "USD" });
    const { res, integration } = await connectShopify(fake, session, A, shop);
    expect(res.status).toBe(303);
    expect(integration).toMatchObject({
      orgId: A.org.id,
      status: "connected",
      domain: shop,
      brandId: A.brand.id,
      credentialsKeyId: "v1",
    });
    const token = fake.shop(shop).accessToken!;
    expect(integration!.credentialsCiphertext).not.toContain(token);
    expect(decryptSecret(integration!.credentialsCiphertext!, "v1")).toBe(token);
    const [store] = await db()
      .select()
      .from(stores)
      .where(eq(stores.integrationId, integration!.id));
    expect(store).toMatchObject({ orgId: A.org.id, brandId: A.brand.id, currency: "USD" });
    expect(fake.shop(shop).webhooks).toHaveLength(5);
    expect(await jobsFor("integrations.reconcile", A.org.id)).toHaveLength(1);
    const audits = await db().select().from(auditLogs).where(eq(auditLogs.orgId, A.org.id));
    expect(audits.map((a) => a.action)).toContain("integration.connected");
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(await res.text()).not.toContain(token);
  });
});

describe("OAuth state validation", () => {
  let A: Tenant;
  let shop: string;
  beforeEach(async () => {
    A = await createTenant("State A");
    shop = uniqueShop();
    fake.createShop(shop);
    session.actAs(A.owner);
  });

  it("rejects a callback with a bad signature before touching state", async () => {
    const { state } = await beginInstall(A, shop);
    const q = fake.callbackQuery({ shop, state: state!, secret: "wrong" });
    expect((await finishInstall(q)).status).toBe(400);
    const [row] = await db().select().from(oauthStates).where(eq(oauthStates.shop, shop));
    expect(row!.usedAt).toBeNull();
  });

  it("rejects an expired state", async () => {
    const { state } = await beginInstall(A, shop);
    await db()
      .update(oauthStates)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthStates.shop, shop));
    const res = await finishInstall(fake.callbackQuery({ shop, state: state! }));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired/);
  });

  it("rejects a reused state", async () => {
    const { state } = await beginInstall(A, shop);
    expect((await finishInstall(fake.callbackQuery({ shop, state: state! }))).status).toBe(303);
    const again = await finishInstall(fake.callbackQuery({ shop, state: state! }));
    expect(again.status).toBe(400);
    expect(await again.text()).toMatch(/already used/);
  });

  it("rejects a state issued to another org (404) and to another user of the same org (404)", async () => {
    const B = await createTenant("State B");
    session.actAs(B.owner);
    const { state: bState } = await beginInstall(B, shop);
    session.actAs(A.owner);
    expect((await finishInstall(fake.callbackQuery({ shop, state: bState! }))).status).toBe(404);

    const { memberships } = await import("@/db/schema");
    const colleague = await createUser();
    await db().insert(memberships).values({ orgId: A.org.id, userId: colleague.id, role: "admin" });
    const { state: aState } = await beginInstall(A, shop);
    session.actAs(colleague);
    expect((await finishInstall(fake.callbackQuery({ shop, state: aState! }))).status).toBe(404);
    expect(
      await db().select().from(integrations).where(eq(integrations.externalShopId, shop)),
    ).toEqual([]);
  });

  it("rejects a callback for a different shop than the install request", async () => {
    const { state } = await beginInstall(A, shop);
    const other = uniqueShop();
    fake.createShop(other);
    const res = await finishInstall(fake.callbackQuery({ shop: other, state: state! }));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/shop does not match/);
  });
});

describe("hijack refusal and reconnect (§9.7)", () => {
  it("a shop connected to org B cannot be connected by org A: 409, audit, review item", async () => {
    const A = await createTenant("Hijacker");
    const B = await createTenant("Victim");
    const shop = uniqueShop();
    const { integration: owned } = await connectShopify(fake, session, B, shop);
    const tokenBefore = owned!.credentialsCiphertext;

    const { res } = await connectShopify(fake, session, A, shop);
    expect(res.status).toBe(409);
    const after = await integrationRow(owned!.id);
    expect(after.orgId).toBe(B.org.id);
    expect(after.credentialsCiphertext).toBe(tokenBefore);

    const [review] = await db()
      .select()
      .from(reviewQueueItems)
      .where(eq(reviewQueueItems.entityId, owned!.id));
    expect(review).toMatchObject({ type: "integration_conflict", orgId: A.org.id, status: "open" });
    const aAudit = await db().select().from(auditLogs).where(eq(auditLogs.orgId, A.org.id));
    expect(aAudit.map((a) => a.action)).toContain("integration.connect_refused");
    expect(JSON.stringify(aAudit)).not.toContain(B.org.id);
    const bAudit = await db().select().from(auditLogs).where(eq(auditLogs.orgId, B.org.id));
    expect(bAudit.map((a) => a.action)).toContain("integration.foreign_connect_attempt");

    expect((await connectShopify(fake, session, A, shop)).res.status).toBe(409);
    expect(
      await db().select().from(reviewQueueItems).where(eq(reviewQueueItems.entityId, owned!.id)),
    ).toHaveLength(1);
  });

  it("reconnecting the same shop to the same org reattaches the integration and keeps mappings", async () => {
    const A = await createTenant("Reconnect");
    const shop = uniqueShop();
    const { integration } = await connectShopify(fake, session, A, shop);
    const { variants } = await seedBrandProduct(A);
    await db().insert(productSyncMappings).values({
      orgId: A.org.id,
      integrationId: integration!.id,
      brandProductVariantId: variants[0]!.id,
      externalVariantId: "999",
      syncStatus: "synced",
    });
    await db()
      .update(integrations)
      .set({ status: "disconnected", credentialsCiphertext: null, credentialsKeyId: null })
      .where(eq(integrations.id, integration!.id));

    const { res, integration: again } = await connectShopify(fake, session, A, shop);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/reconnected/);
    expect(again!.id).toBe(integration!.id);
    expect(again!.status).toBe("connected");
    expect(decryptSecret(again!.credentialsCiphertext!, "v1")).toBe(fake.shop(shop).accessToken);
    expect(
      await db()
        .select()
        .from(productSyncMappings)
        .where(eq(productSyncMappings.integrationId, integration!.id)),
    ).toHaveLength(1);
    expect(
      await db().select().from(stores).where(eq(stores.integrationId, integration!.id)),
    ).toHaveLength(1);
    const actions = (await db().select().from(auditLogs).where(eq(auditLogs.orgId, A.org.id))).map(
      (a) => a.action,
    );
    expect(actions).toContain("integration.reconnected");
  });
});

async function approvedProductWithMockups(tenant: Tenant) {
  const seeded = await seedBrandProduct(tenant);
  const png = bytesOf(PNG_HEADER, 64);
  const m1 = await createAsset(tenant.org.id, {
    kind: "mockup",
    uploadStatus: "ready",
    bytes: 64,
    content: png,
  });
  const m2 = await createAsset(tenant.org.id, {
    kind: "mockup",
    uploadStatus: "ready",
    bytes: 64,
    content: bytesOf(PNG_HEADER, 64).map((b, i) => (i > 10 ? 7 : b)),
  });
  const [tpl] = await db().insert(labelTemplates).values({ name: "T", printSpec: {} }).returning();
  await db()
    .insert(labels)
    .values({
      orgId: tenant.org.id,
      brandId: tenant.brand.id,
      brandProductId: seeded.brandProduct.id,
      labelTemplateId: tpl!.id,
      version: 1,
      mockupAssetIds: [m1.id, m2.id],
      status: "approved",
    });
  await db()
    .update(brandProducts)
    .set({ status: "approved" })
    .where(eq(brandProducts.id, seeded.brandProduct.id));
  return seeded;
}

const publish = (id: string, body: unknown = {}) =>
  publishRoute.POST(
    new Request(`http://test/api/brand-products/${id}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("publish", () => {
  let A: Tenant;
  let shop: string;
  let integrationId: string;
  beforeEach(async () => {
    A = await createTenant("Publisher");
    shop = uniqueShop();
    integrationId = (await seedShopifyIntegration(fake, A, shop)).integration.id;
    session.actAs(A.owner);
  });

  it("refuses unapproved products (409) and other orgs' integrations (404)", async () => {
    const { brandProduct } = await seedBrandProduct(A);
    expect((await publish(brandProduct.id)).status).toBe(409);
    const B = await createTenant("Other");
    const { integration: bIntegration } = await seedShopifyIntegration(fake, B, uniqueShop());
    const { brandProduct: approved } = await approvedProductWithMockups(A);
    expect((await publish(approved.id, { integrationId: bIntegration.id })).status).toBe(404);
    expect(await jobsFor("integrations.publish_product", B.org.id)).toHaveLength(0);
  });

  it("refuses a needs_reauth integration (409)", async () => {
    const { brandProduct } = await approvedProductWithMockups(A);
    await db()
      .update(integrations)
      .set({ status: "needs_reauth" })
      .where(eq(integrations.id, integrationId));
    expect((await publish(brandProduct.id)).status).toBe(409);
  });

  it("pushes product + mockups, writes mappings, marks published, and skips unchanged pushes", async () => {
    const { brandProduct, variants } = await approvedProductWithMockups(A);
    const res = await publish(brandProduct.id);
    expect(res.status).toBe(202);
    await drainIntegrationJobs();

    const products = [...fake.shop(shop).products.values()];
    expect(products).toHaveLength(1);
    expect(products[0]!.images).toHaveLength(2);
    expect(products[0]!.variants.map((v) => v.price)).toEqual(["29.99", "29.99"]);
    const mappings = await db()
      .select()
      .from(productSyncMappings)
      .where(eq(productSyncMappings.integrationId, integrationId));
    expect(mappings.map((m) => m.brandProductVariantId).sort()).toEqual(
      variants.map((v) => v.id).sort(),
    );
    for (const m of mappings) {
      expect(m).toMatchObject({
        orgId: A.org.id,
        syncStatus: "synced",
        externalProductId: String(products[0]!.id),
      });
      expect(m.lastPushHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const [bp] = await db()
      .select()
      .from(brandProducts)
      .where(eq(brandProducts.id, brandProduct.id));
    expect(bp!.status).toBe("published");

    const productCalls = () => fake.requests.filter((r) => r.path.includes("/products")).length;
    const before = productCalls();
    expect((await publish(brandProduct.id)).status).toBe(202);
    await drainIntegrationJobs();
    expect(productCalls()).toBe(before);

    const { brandProductVariants } = await import("@/db/schema");
    await db()
      .update(brandProductVariants)
      .set({ retailPriceMinor: 3499n })
      .where(eq(brandProductVariants.id, variants[0]!.id));
    await publish(brandProduct.id);
    await drainIntegrationJobs();
    expect(
      fake.requests.filter((r) => r.method === "PUT" && r.path.includes("/products/")),
    ).toHaveLength(1);
    expect(fake.shop(shop).products.size).toBe(1);
    const prices = [...fake.shop(shop).products.values()][0]!.variants.map((v) => v.price).sort();
    expect(prices).toEqual(["29.99", "34.99"]);
  });

  it("a 401 during publish flips the integration to needs_reauth and stops", async () => {
    const { brandProduct } = await approvedProductWithMockups(A);
    await publish(brandProduct.id);
    fake.revokeToken(shop);
    await drainIntegrationJobs();
    expect((await integrationRow(integrationId)).status).toBe("needs_reauth");
    const [job] = await jobsFor("integrations.publish_product", A.org.id);
    expect(job!.status).toBe("succeeded");
    const actions = (await db().select().from(auditLogs).where(eq(auditLogs.orgId, A.org.id))).map(
      (a) => a.action,
    );
    expect(actions).toContain("integration.needs_reauth");
  });
});

describe("webhook ingress", () => {
  let A: Tenant;
  let shop: string;
  let integrationId: string;
  beforeEach(async () => {
    A = await createTenant("Hooks");
    shop = uniqueShop();
    integrationId = (await seedShopifyIntegration(fake, A, shop)).integration.id;
  });

  const deliver = (req: Request) => webhookRoute.POST(req);
  const eventsFor = (eventId: string) =>
    db()
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.dedupeKey, `shopify:${eventId}`));

  it("rejects bad signatures with 401 and persists nothing", async () => {
    const payload = fake.orderPayload();
    for (const [eventId, over] of [
      ["bad-1", { secret: "wrong" }],
      ["bad-2", { hmac: null }],
      ["bad-3", { hmac: "AAAA" }],
    ] as const) {
      const res = await deliver(
        fake.webhookRequest({ topic: "orders/paid", shop, payload, eventId, ...over }),
      );
      expect(res.status).toBe(401);
      expect(await eventsFor(eventId)).toEqual([]);
    }
    const tampered = fake.webhookRequest({ topic: "orders/paid", shop, payload, eventId: "bad-4" });
    const body = (await tampered.text()).replace('"paid"', '"refunded"');
    const res = await deliver(
      new Request(tampered.url, { method: "POST", headers: tampered.headers, body }),
    );
    expect(res.status).toBe(401);
    expect(await eventsFor("bad-4")).toEqual([]);
  });

  it("persists + enqueues once; a duplicate delivery is 200 with no second job", async () => {
    const payload = fake.addOrder(shop, fake.orderPayload());
    const eventId = `evt-${Date.now()}`;
    const r1 = await deliver(fake.webhookRequest({ topic: "orders/paid", shop, payload, eventId }));
    const r2 = await deliver(fake.webhookRequest({ topic: "orders/paid", shop, payload, eventId }));
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const events = await eventsFor(eventId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ integrationId, status: "received", signatureValid: true });
    expect(await jobsFor("integrations.process_webhook", A.org.id)).toHaveLength(1);
    expect(ingest).not.toHaveBeenCalled();

    await drainIntegrationJobs();
    expect(ingest).toHaveBeenCalledTimes(1);
    const [target, order] = ingest.mock.calls[0]!;
    expect(target).toEqual({ orgId: A.org.id, integrationId });
    expect(order).toMatchObject({ externalOrderId: String(payload.id), totalMinor: 6497n });
    const [ev] = await eventsFor(eventId);
    expect(ev).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("marks the event failed (with error) and retries when ingest throws", async () => {
    ingest.mockRejectedValueOnce(new Error("boom"));
    const eventId = `evt-fail-${Date.now()}`;
    const payload = fake.addOrder(shop, fake.orderPayload());
    await deliver(fake.webhookRequest({ topic: "orders/create", shop, payload, eventId }));
    await drainJobs({ limit: 50 });
    const [ev] = await eventsFor(eventId);
    expect(ev).toMatchObject({ status: "failed", attempts: 1, error: "boom" });
    const [job] = await jobsFor("integrations.process_webhook", A.org.id);
    expect(job).toMatchObject({ status: "pending", lastError: "boom" });
  });

  it("a signed body replayed under another shop's header never reaches that shop's org", async () => {
    const other = uniqueShop();
    await seedShopifyIntegration(fake, await createTenant("Victim"), other);
    const payload = fake.addOrder(shop, fake.orderPayload());
    const eventId = `evt-replay-${Date.now()}`;
    const res = await deliver(
      fake.webhookRequest({ topic: "orders/paid", shop: other, payload, eventId }),
    );
    expect(res.status).toBe(200);
    await drainIntegrationJobs();
    expect(ingest).not.toHaveBeenCalled();
    const [ev] = await eventsFor(eventId);
    expect(ev).toMatchObject({ status: "ignored", error: expect.stringContaining("not found") });
  });

  it("app/uninstalled disconnects the integration and drops credentials", async () => {
    await deliver(
      fake.webhookRequest({ topic: "app/uninstalled", shop, payload: { id: 1, domain: shop } }),
    );
    await drainIntegrationJobs();
    const row = await integrationRow(integrationId);
    expect(row).toMatchObject({ status: "disconnected", credentialsCiphertext: null });
    await expect(
      pushShipmentToStore(A.org.id, integrationId, {
        externalOrderId: "1",
        lines: [],
        tracking: { number: "x", carrier: "UPS", url: null },
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(IntegrationUnavailableError);
    expect(await scheduleReconciliation()).toBeGreaterThanOrEqual(0);
    expect(await jobsFor("integrations.reconcile", A.org.id)).toHaveLength(0);
  });

  it("a webhook for an unknown shop is acknowledged, recorded as ignored, and enqueues nothing", async () => {
    const eventId = `evt-unknown-${Date.now()}`;
    const res = await deliver(
      fake.webhookRequest({
        topic: "orders/paid",
        shop: uniqueShop("ghost"),
        payload: fake.orderPayload(),
        eventId,
      }),
    );
    expect(res.status).toBe(200);
    const [ev] = await eventsFor(eventId);
    expect(ev).toMatchObject({ status: "ignored", integrationId: null });
    const jobs = await db()
      .select()
      .from(jobQueue)
      .where(sql`${jobQueue.payload}->>'webhookEventId' = ${ev!.id}`);
    expect(jobs).toEqual([]);
  });
});

describe("reconciliation poller", () => {
  it("schedules one job per connected integration per 15-minute bucket", async () => {
    const A = await createTenant("Poll A");
    const { integration } = await seedShopifyIntegration(fake, A, uniqueShop());
    const now = new Date("2026-09-25T10:05:00Z");
    await scheduleReconciliation(now);
    await scheduleReconciliation(new Date("2026-09-25T10:14:59Z"));
    const jobs = await jobsFor("integrations.reconcile", A.org.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ integrationId: integration.id });
    await scheduleReconciliation(new Date("2026-09-25T10:15:00Z"));
    expect(await jobsFor("integrations.reconcile", A.org.id)).toHaveLength(2);
  });

  it("ingests updated orders, advances orders_synced_through, and overlaps the next window", async () => {
    const A = await createTenant("Poll B");
    const shop = uniqueShop();
    const { integration } = await seedShopifyIntegration(fake, A, shop);
    fake.pageSize = 2;
    const t0 = Date.now() - 60 * 60 * 1000;
    const orders = [0, 1, 2].map((i) =>
      fake.addOrder(
        shop,
        fake.orderPayload({ updated_at: new Date(t0 + i * 60_000).toISOString() }),
      ),
    );
    fake.addOrder(
      shop,
      fake.orderPayload({ updated_at: new Date(Date.now() - 40 * 86400_000).toISOString() }),
    );

    const { runReconcileJob } = await import("@/modules/integrations");
    expect(await runReconcileJob(A.org.id, { integrationId: integration.id })).toEqual({
      ingested: 3,
    });
    expect(ingest.mock.calls.map(([, o]) => o.externalOrderId).sort()).toEqual(
      orders.map((o) => String(o.id)).sort(),
    );
    expect(ingest.mock.calls.every(([t]) => t.orgId === A.org.id)).toBe(true);
    const row = await integrationRow(integration.id);
    expect(row.ordersSyncedThrough).toEqual(new Date(t0 + 2 * 60_000));
    expect(row.lastSyncAt).not.toBeNull();

    fake.requests = [];
    await runReconcileJob(A.org.id, { integrationId: integration.id });
    const first = new URL(
      `https://x${fake.requests.find((r) => r.path.includes("orders.json"))!.path}`,
    );
    expect(first.searchParams.get("updated_at_min")).toBe(
      new Date(t0 + 2 * 60_000 - 5 * 60_000).toISOString(),
    );
  });

  it("a 401 while polling marks the integration needs_reauth and ingests nothing", async () => {
    const A = await createTenant("Poll C");
    const shop = uniqueShop();
    const { integration } = await seedShopifyIntegration(fake, A, shop);
    fake.addOrder(shop, fake.orderPayload());
    fake.revokeToken(shop);
    const { runReconcileJob } = await import("@/modules/integrations");
    expect(await runReconcileJob(A.org.id, { integrationId: integration.id })).toEqual({
      ingested: 0,
    });
    expect(ingest).not.toHaveBeenCalled();
    expect((await integrationRow(integration.id)).status).toBe("needs_reauth");
  });
});

describe("pushShipmentToStore (Milestone 5 entry point)", () => {
  it("decrypts, pushes once per tracking number, and refuses other orgs' integrations", async () => {
    const A = await createTenant("Ship A");
    const B = await createTenant("Ship B");
    const shop = uniqueShop();
    const { integration } = await seedShopifyIntegration(fake, A, shop);
    const order = fake.addOrder(shop, fake.orderPayload());
    const push = {
      externalOrderId: String(order.id),
      lines: [{ externalLineItemId: String(order.line_items[0]!.id), quantity: 2 }],
      tracking: { number: "1ZTRACK", carrier: "UPS", url: "https://ups.test/1ZTRACK" },
      idempotencyKey: "shipment-1",
    };
    const a = await pushShipmentToStore(A.org.id, integration.id, push);
    const b = await pushShipmentToStore(A.org.id, integration.id, push);
    expect(b).toEqual(a);
    expect(fake.shop(shop).fulfillments).toHaveLength(1);
    expect(fake.shop(shop).fulfillments[0]).toMatchObject({
      tracking_number: "1ZTRACK",
      tracking_company: "UPS",
    });

    const err = await pushShipmentToStore(B.org.id, integration.id, push).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationUnavailableError);
    expect(err.reason).toBe("not_found");

    fake.revokeToken(shop);
    const auth = await pushShipmentToStore(A.org.id, integration.id, {
      ...push,
      tracking: { ...push.tracking, number: "NEW" },
    }).catch((e) => e);
    expect(auth).toBeInstanceOf(IntegrationUnavailableError);
    expect((await integrationRow(integration.id)).status).toBe("needs_reauth");
  });
});

describe("credentials never leak", () => {
  it("no audit row, job payload, job error or webhook event contains an access token", async () => {
    const tokens = [...fake.shops.values()].map((s) => s.accessToken).filter(Boolean) as string[];
    const A = await createTenant("Leak check");
    const shop = uniqueShop();
    await connectShopify(fake, session, A, shop);
    tokens.push(fake.shop(shop).accessToken!);
    const dump = JSON.stringify([
      await db().select().from(auditLogs),
      await db().select().from(jobQueue),
      await db().select().from(webhookEvents),
    ]);
    for (const t of tokens) expect(dump).not.toContain(t);
    const all = await db().select({ c: integrations.credentialsCiphertext }).from(integrations);
    for (const t of tokens) expect(JSON.stringify(all)).not.toContain(t);
  });
});
