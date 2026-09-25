/**
 * The MVP order loop, end to end, through the real route handlers against a real Postgres.
 * Only the session source, object storage and Shopify's HTTP API are faked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { privilegedDb } from "@/db/privileged";
import { jobQueue, ledgerEntries, platformAdmins, users } from "@/db/schema";
import { parseCsv, toCsv } from "@/adapters/manual/csv";
import { setShopifyFetchForTests } from "@/adapters/shopify";
import { setStorageProviderForTests } from "@/modules/assets";
import { completeEmailLink, setSessionSourceForTests, signUp } from "@/modules/auth";
import { registerFulfillmentJobs } from "@/modules/fulfillment";
import { registerIntegrationJobs } from "@/modules/integrations";
import { drainJobs } from "@/modules/jobs";
import { priceOrder, feeRulesSchema } from "@/modules/pricing";
import * as brandsRoute from "@/app/api/brands/route";
import * as catalogRoute from "@/app/api/catalog/products/route";
import * as catalogProductRoute from "@/app/api/catalog/products/[id]/route";
import * as brandProductsRoute from "@/app/api/brand-products/route";
import * as brandProductRoute from "@/app/api/brand-products/[id]/route";
import * as uploadsRoute from "@/app/api/assets/uploads/route";
import * as completeRoute from "@/app/api/assets/[id]/complete/route";
import * as labelsRoute from "@/app/api/brand-products/[id]/labels/route";
import * as labelRoute from "@/app/api/labels/[id]/route";
import * as submitRoute from "@/app/api/labels/[id]/submit/route";
import * as adminLabelsRoute from "@/app/api/admin/labels/route";
import * as approveRoute from "@/app/api/admin/labels/[id]/approve/route";
import * as publishRoute from "@/app/api/brand-products/[id]/publish/route";
import * as webhookRoute from "@/app/api/webhooks/shopify/route";
import * as ordersRoute from "@/app/api/orders/route";
import * as orderRoute from "@/app/api/orders/[id]/route";
import * as markPaidRoute from "@/app/api/admin/orders/[id]/mark-paid/route";
import * as dispatchRoute from "@/app/api/admin/dispatch-batches/route";
import * as dispatchFileRoute from "@/app/api/admin/dispatch-batches/[id]/file/route";
import * as dispatchImportRoute from "@/app/api/admin/dispatch-batches/[id]/import/route";
import { seedPlatform } from "../../scripts/seed/platform";
import { FakeSession } from "../fake-session";
import { fakeStorage } from "../fake-storage";
import { FakeShopify } from "../fake-shopify";
import { beginInstall, finishInstall } from "../shopify-helpers";
import { createUser } from "../helpers";

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const session = new FakeSession();
const shopify = new FakeShopify();
const SHOP = `e2e-${Date.now()}.myshopify.com`;

async function call(
  handler: unknown,
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
) {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await (handler as Handler)(new Request(`http://test${path}`, init), {
    params: Promise.resolve(params),
  });
  const text = await res.clone().text();
  return {
    res,
    status: res.status,
    text,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are asserted field by field
    json: () => JSON.parse(text) as any,
  };
}

async function drainAll() {
  for (let i = 0; i < 20; i++) {
    const r = await drainJobs({ limit: 50 });
    if (r.succeeded + r.retried + r.dead === 0) return;
  }
}

beforeAll(() => {
  setSessionSourceForTests(session);
  setStorageProviderForTests(fakeStorage);
  setShopifyFetchForTests(shopify.fetch);
  registerIntegrationJobs();
  registerFulfillmentJobs();
});
afterAll(async () => {
  setSessionSourceForTests(null);
  setStorageProviderForTests(null);
  setShopifyFetchForTests(null);
  await privilegedDb()
    .delete(jobQueue)
    .where(sql`${jobQueue.status} <> 'succeeded'`);
});

describe("MVP order loop, end to end", () => {
  it("signup → label → approval → publish → webhook order → pricing → payment → dispatch → tracking → shipped", async () => {
    const platform = await seedPlatform();
    const rules = feeRulesSchema.parse(platform.feeSchedule.rules);

    // 1. Signup provisions the org; email verification signs the owner in.
    const email = `founder-${Date.now()}@brand.test`;
    expect(
      await signUp({ email, password: "correct-horse-battery", orgName: "E2E Nutrition" }),
    ).toEqual({ ok: true });
    expect((await completeEmailLink(email)).ok).toBe(true);
    const [owner] = await privilegedDb().select().from(users).where(eq(users.email, email));

    // 2. Create a brand.
    const brand = await call(brandsRoute.POST, "POST", "/api/brands", { name: "Peak Form" });
    expect(brand.status).toBe(201);
    const brandId = brand.json().id as string;

    // 3. Pick a catalog product and price it.
    const catalog = (await call(catalogRoute.GET, "GET", "/api/catalog/products")).json();
    const listed = catalog.products.find((p: { id: string }) => p.id === platform.product.id);
    expect(listed).toBeTruthy();
    const product = (
      await call(catalogProductRoute.GET, "GET", "/x", undefined, { id: listed.id })
    ).json();
    const sku = product.skus.find((s: { id: string }) => s.id === platform.skus[0]!.id);
    const bp = await call(brandProductsRoute.POST, "POST", "/api/brand-products", {
      brandId,
      catalogProductId: product.id,
      currency: "USD",
      variants: [{ skuId: sku.id, retailPriceMinor: 2999 }],
    });
    expect(bp.status).toBe(201);
    const brandProductId = bp.json().id as string;
    expect(bp.json().variants[0].margin.marginMinor).toBe(
      String(
        2999n -
          priceOrder([{ quantity: 1, unitCostMinor: BigInt(sku.baseCostMinor) }], rules).totalMinor,
      ),
    );

    // 4. Upload a logo: presigned upload, bytes land in storage, magic-byte verification.
    const png = new Uint8Array(
      await sharp({ create: { width: 400, height: 400, channels: 4, background: "#0a7" } })
        .png()
        .toBuffer(),
    );
    const up = await call(uploadsRoute.POST, "POST", "/api/assets/uploads", {
      kind: "logo",
      mime: "image/png",
      bytes: png.length,
    });
    expect(up.status).toBe(201);
    const uploadUrl = new URL(up.json().upload.url);
    const [, , bucket, ...keyParts] = uploadUrl.pathname.split("/");
    fakeStorage.put(bucket!, keyParts.join("/"), png);
    const logoId = up.json().asset.id as string;
    const done = await call(completeRoute.POST, "POST", "/x", undefined, { id: logoId });
    expect(done.json().uploadStatus).toBe("ready");

    // 5. Design a label on the product's (placeholder) template and submit it.
    const draft = await call(labelsRoute.POST, "POST", "/x", {}, { id: brandProductId });
    expect(draft.status).toBe(201);
    const labelId = draft.json().id as string;
    const design = {
      brandName: "Peak Form",
      variantName: "Unflavored",
      logo: logoId,
      backgroundColor: "#ffffff",
      textColor: "#101010",
    };
    const saved = await call(
      labelRoute.PATCH,
      "PATCH",
      "/x",
      { designState: design },
      { id: labelId },
    );
    expect(saved.status).toBe(200);
    expect(saved.json().previewAssetId).toBeTruthy();
    expect(
      (await call(submitRoute.POST, "POST", "/x", undefined, { id: labelId })).status,
    ).toBeLessThan(300);

    // 6. A platform admin approves it: print-ready PDF + mockups are generated and frozen.
    const admin = await createUser();
    await privilegedDb().insert(platformAdmins).values({ userId: admin.id });
    session.actAs(admin);
    const queue = (await call(adminLabelsRoute.GET, "GET", "/api/admin/labels")).text;
    expect(queue).toContain(labelId);
    expect(
      (await call(approveRoute.POST, "POST", "/x", undefined, { id: labelId })).status,
    ).toBeLessThan(300);
    session.actAs(owner!);
    const approved = (await call(labelRoute.GET, "GET", "/x", undefined, { id: labelId })).json();
    expect(approved.status).toBe("approved");
    expect(approved.mockupAssetIds.length).toBeGreaterThanOrEqual(2);
    const pdfKey = [...fakeStorage.objects.entries()].find(([k]) =>
      k.includes(`/${approved.printFileAssetId}/`),
    );
    expect(Buffer.from(pdfKey![1].slice(0, 5)).toString()).toBe("%PDF-");

    // 7. Connect the Shopify store (OAuth) and publish the product with its mockups.
    shopify.createShop(SHOP, { currency: "USD" });
    const { state } = await beginInstall(
      { owner: owner!, org: { id: "" }, brand: { id: brandId } } as never,
      SHOP,
      brandId,
    );
    const cb = await finishInstall(shopify.callbackQuery({ shop: SHOP, state: state! }));
    expect(cb.status).toBeLessThan(400);
    const pub = await call(publishRoute.POST, "POST", "/x", {}, { id: brandProductId });
    expect(pub.status).toBe(202);
    await drainAll();
    const storeProducts = [...shopify.shops.get(SHOP)!.products.values()];
    expect(storeProducts).toHaveLength(1);
    expect(storeProducts[0]!.images.length).toBeGreaterThanOrEqual(2);
    const storeVariant = storeProducts[0]!.variants[0] as {
      id: number;
      sku: string;
      price: string;
    };
    expect(storeVariant).toMatchObject({ sku: sku.sku, price: "29.99" });
    expect(
      (await call(brandProductRoute.GET, "GET", "/x", undefined, { id: brandProductId })).json()
        .status,
    ).toBe("published");

    // 8. A consumer orders on the store; the paid-order webhook arrives.
    const storeOrder = shopify.addOrder(
      SHOP,
      shopify.orderPayload({
        line_items: [
          {
            id: 91001,
            variant_id: storeVariant.id,
            sku: sku.sku,
            title: "Creatine",
            quantity: 2,
            price: "29.99",
          },
        ],
        subtotal_price: "59.98",
        total_price: "64.97",
      }),
    );
    const hook = await webhookRoute.POST(
      shopify.webhookRequest({ topic: "orders/paid", shop: SHOP, payload: storeOrder }),
    );
    expect(hook.status).toBe(200);
    await drainAll();

    // 9. Line resolves to our SKU; order priced from the versioned fee schedule; charge + ledger.
    const orders = (await call(ordersRoute.GET, "GET", "/api/orders")).json().orders;
    expect(orders).toHaveLength(1);
    const orderId = orders[0].id as string;
    let detail = (await call(orderRoute.GET, "GET", "/x", undefined, { id: orderId })).json();
    expect(detail.order.status).toBe("awaiting_payment");
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({ skuId: sku.id, labelId, quantity: 2 });
    const expected = priceOrder([{ quantity: 2, unitCostMinor: BigInt(sku.baseCostMinor) }], rules);
    expect(detail.charge).toMatchObject({
      status: "pending_external",
      amountMinor: String(expected.totalMinor),
      currency: "USD",
      feeScheduleId: platform.feeSchedule.id,
    });
    const ledger = await privilegedDb()
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orderId, orderId));
    expect(ledger.reduce((s, l) => s + l.amountMinor, 0n)).toBe(expected.totalMinor);

    // 10. Admin marks it paid (manual PaymentProvider); fulfillment picks it up.
    session.actAs(admin);
    const paid = await call(
      markPaidRoute.POST,
      "POST",
      "/x",
      { reference: "WIRE-E2E-1", note: "received" },
      { id: orderId },
    );
    expect(paid.status).toBeLessThan(300);
    await drainAll();
    const afterPay = await privilegedDb()
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orderId, orderId));
    expect(afterPay.reduce((s, l) => s + l.amountMinor, 0n)).toBe(0n);

    // 11. Order enters a dispatch batch; the CSV is exported.
    const batch = await call(dispatchRoute.POST, "POST", "/api/admin/dispatch-batches", {
      fulfillmentCenterId: platform.fulfillmentCenter.id,
    });
    expect(batch.status).toBe(201);
    const batchId = batch.json().id as string;
    const file = await call(dispatchFileRoute.GET, "GET", "/x", undefined, { id: batchId });
    expect(file.res.headers.get("content-type")).toBe("text/csv");
    const [header, ...rows] = parseCsv(file.text);
    const col = (name: string) => header!.indexOf(name);
    const ours = rows.filter((r) => r[col("order_number")] === storeOrder.name);
    expect(ours).toHaveLength(1);
    expect(ours[0]![col("partner_sku")]).toBe("MFR-CRE60-U");
    expect(ours[0]![col("quantity")]).toBe("2");
    expect(ours[0]![col("artwork_url")]).toContain(approved.printFileAssetId);

    // 12. The partner's completed sheet comes back with tracking and is imported.
    const completed = rows.map((r) => {
      const out = r.slice();
      out[col("status")] = "Shipped";
      out[col("carrier")] = "UPS";
      out[col("tracking_number")] = `1ZE2E${r[col("order_reference")]!.slice(-8)}`;
      out[col("shipped_at")] = "2026-09-25T09:00:00Z";
      out[col("lot_number")] = "LOT-2026-09";
      return out;
    });
    const imported = await call(dispatchImportRoute.POST, "POST", "/x", toCsv(header!, completed), {
      id: batchId,
    });
    expect(imported.status).toBe(200);
    expect(imported.json().applied.length).toBeGreaterThanOrEqual(1);
    expect(imported.json().errors).toEqual([]);

    // 13. Fulfillment + tracking are pushed back to Shopify, exactly once.
    await drainAll();
    const shop = shopify.shops.get(SHOP)!;
    const fulfillments = shop.fulfillments.filter((f) => f.order_id === storeOrder.id);
    expect(fulfillments).toHaveLength(1);
    expect(JSON.stringify(fulfillments[0])).toContain("1ZE2E");
    await call(dispatchImportRoute.POST, "POST", "/x", toCsv(header!, completed), { id: batchId });
    await drainAll();
    expect(shop.fulfillments.filter((f) => f.order_id === storeOrder.id)).toHaveLength(1);

    // 14. The brand's order timeline shows it shipped.
    session.actAs(owner!);
    detail = (await call(orderRoute.GET, "GET", "/x", undefined, { id: orderId })).json();
    expect(detail.order.status).toBe("shipped");
    expect(detail.shipments).toHaveLength(1);
    expect(detail.shipments[0]).toMatchObject({ carrier: "UPS", lotNumber: "LOT-2026-09" });
    expect(detail.shipments[0].pushedToStoreAt).toBeTruthy();
    const timeline = detail.timeline.map((e: { type: string }) => e.type);
    for (const step of [
      "payment_recorded",
      "submitted_to_fulfillment",
      "dispatched_in_batch",
      "tracking_pushed_to_store",
    ])
      expect(timeline).toContain(step);
    expect(detail.timeline.some((e: { toStatus: string }) => e.toStatus === "shipped")).toBe(true);
  });
});
