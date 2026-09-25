import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  decimalToMinor,
  minorToDecimal,
  setShopifyFetchForTests,
  shopify,
} from "@/adapters/shopify";
import { ProviderAuthError } from "@/modules/integrations/provider";
import { FakeShopify } from "./fake-shopify";

const SHOP = "acme-store.myshopify.com";
let fake: FakeShopify;
let conn: { shop: string; accessToken: string };

beforeEach(async () => {
  fake = new FakeShopify();
  setShopifyFetchForTests(fake.fetch);
  fake.createShop(SHOP);
  const auth = await shopify.completeAuthorization(fake.callbackQuery({ shop: SHOP, state: "s" }));
  conn = { shop: SHOP, accessToken: auth!.accessToken };
});
afterAll(() => setShopifyFetchForTests(null));

describe("shop domain validation", () => {
  it.each([
    ["Acme-Store.myshopify.com", "acme-store.myshopify.com"],
    ["evil.com", null],
    ["-x.myshopify.com", null],
    ["acme.myshopify.com.evil.com", null],
    ["acme.myshopify.com/admin", null],
    ["a_b.myshopify.com", null],
  ])("%s → %s", (input, want) => {
    expect(shopify.normalizeShop(input)).toBe(want);
  });
});

describe("OAuth callback HMAC", () => {
  it("accepts a correctly signed query and exchanges the code", async () => {
    const q = fake.callbackQuery({ shop: SHOP, state: "abc" });
    expect(shopify.verifyCallback(q)).toBe(true);
    const out = await shopify.completeAuthorization(q);
    expect(out).toMatchObject({ shop: SHOP, scopes: ["write_products", "read_orders"] });
  });

  it("rejects a tampered parameter, a wrong secret, and a missing hmac", async () => {
    const tampered = fake.callbackQuery({ shop: SHOP, state: "abc" });
    tampered.set("state", "other");
    expect(shopify.verifyCallback(tampered)).toBe(false);
    expect(await shopify.completeAuthorization(tampered)).toBeNull();

    const wrong = fake.callbackQuery({ shop: SHOP, state: "abc", secret: "nope" });
    expect(shopify.verifyCallback(wrong)).toBe(false);

    const missing = fake.callbackQuery({ shop: SHOP, state: "abc" });
    missing.delete("hmac");
    expect(shopify.verifyCallback(missing)).toBe(false);
  });

  it("rejects a signed query for an invalid shop domain", () => {
    fake.createShop("evil.example.com");
    expect(
      shopify.verifyCallback(fake.callbackQuery({ shop: "evil.example.com", state: "x" })),
    ).toBe(false);
  });
});

describe("webhook HMAC (raw body)", () => {
  const payload = { id: 1, note: "x" };
  const verify = async (req: Request) => shopify.verifyWebhook(await req.text(), req.headers);

  it("valid signature", async () => {
    expect(await verify(fake.webhookRequest({ topic: "orders/paid", shop: SHOP, payload }))).toBe(
      true,
    );
  });

  it("tampered body", async () => {
    const req = fake.webhookRequest({ topic: "orders/paid", shop: SHOP, payload });
    const raw = (await req.text()).replace('"x"', '"y"');
    expect(shopify.verifyWebhook(raw, req.headers)).toBe(false);
  });

  it("re-serialized body with identical JSON meaning still fails (raw bytes are signed)", async () => {
    const req = fake.webhookRequest({ topic: "orders/paid", shop: SHOP, payload });
    const raw = JSON.stringify(JSON.parse(await req.text()), null, 1);
    expect(shopify.verifyWebhook(raw, req.headers)).toBe(false);
  });

  it("wrong secret and missing header", async () => {
    expect(
      await verify(
        fake.webhookRequest({ topic: "orders/paid", shop: SHOP, payload, secret: "no" }),
      ),
    ).toBe(false);
    expect(
      await verify(fake.webhookRequest({ topic: "orders/paid", shop: SHOP, payload, hmac: null })),
    ).toBe(false);
  });

  it("extracts topic kind, shop and the event id", () => {
    const req = fake.webhookRequest({
      topic: "app/uninstalled",
      shop: SHOP,
      payload,
      eventId: "e1",
    });
    expect(shopify.webhookMeta(req.headers)).toEqual({
      topic: "app/uninstalled",
      kind: "app_uninstalled",
      shop: SHOP,
      eventId: "e1",
    });
  });
});

describe("money parsing (never floats)", () => {
  it.each([
    ["12.34", 1234n],
    ["12.3", 1230n],
    ["12", 1200n],
    ["0.00", 0n],
    ["0.10", 10n],
    ["19.990", 1999n],
    ["1234567890123.45", 123456789012345n],
  ])("%s → %s", (s, want) => expect(decimalToMinor(s)).toBe(want));

  it.each(["12.345", "-1.00", "1e3", "abc", "", "12.", ".5", "0.1.2"])("rejects %s", (s) =>
    expect(decimalToMinor(s)).toBeNull(),
  );

  it("formats minor units without floating point", () => {
    expect(minorToDecimal(1234n)).toBe("12.34");
    expect(minorToDecimal(5n)).toBe("0.05");
    expect(minorToDecimal(0n)).toBe("0.00");
    expect(minorToDecimal(123456789012345678n)).toBe("1234567890123456.78");
  });

  it("0.1 + 0.2 style amounts stay exact", () => {
    const o = shopify.normalizeOrder(
      fake.orderPayload({
        subtotal_price: "0.30",
        total_price: "0.30",
        total_shipping_price_set: { shop_money: { amount: "0.00" } },
        line_items: [
          { id: 1, variant_id: 2, sku: "A", title: "A", quantity: 1, price: "0.10" },
          { id: 3, variant_id: 4, sku: "B", title: "B", quantity: 1, price: "0.20" },
        ],
      }),
    );
    expect(o!.lines.reduce((s, l) => s + l.unitPriceMinor, 0n)).toBe(o!.subtotalMinor);
  });
});

describe("normalizeOrder", () => {
  it("maps a Shopify order to ExternalOrder", () => {
    const p = fake.orderPayload({
      id: 4242,
      name: "#1001",
      line_items: [
        { id: 9, variant_id: 5001, sku: "SKU-1", title: "Creatine", quantity: 2, price: "29.99" },
        { id: 10, variant_id: null, sku: "", title: "Own tee", quantity: 1, price: "10.00" },
        {
          id: 11,
          variant_id: 7,
          sku: "X",
          title: "Removed",
          quantity: 1,
          current_quantity: 0,
          price: "1.00",
        },
      ],
    });
    const o = shopify.normalizeOrder(p)!;
    expect(o).toMatchObject({
      externalOrderId: "4242",
      externalOrderNumber: "#1001",
      currency: "USD",
      financialStatus: "paid",
      cancelled: false,
      test: false,
      subtotalMinor: 5998n,
      shippingMinor: 499n,
      totalMinor: 6497n,
      customer: { externalId: "77", email: "buyer@example.com", name: "Ada Buyer" },
      shipTo: { city: "Austin", countryCode: "US" },
    });
    expect(o.lines).toEqual([
      {
        externalLineItemId: "9",
        externalVariantId: "5001",
        sku: "SKU-1",
        title: "Creatine",
        quantity: 2,
        unitPriceMinor: 2999n,
      },
      {
        externalLineItemId: "10",
        externalVariantId: null,
        sku: null,
        title: "Own tee",
        quantity: 1,
        unitPriceMinor: 1000n,
      },
    ]);
  });

  it("flags cancelled / test orders and maps unknown financial statuses to other", () => {
    const o = shopify.normalizeOrder(
      fake.orderPayload({
        cancelled_at: new Date().toISOString(),
        test: true,
        financial_status: "authorized",
      }),
    )!;
    expect(o).toMatchObject({ cancelled: true, test: true, financialStatus: "other" });
  });

  it("returns null for non-orders and sub-cent amounts", () => {
    expect(shopify.normalizeOrder({ hello: "world" })).toBeNull();
    expect(shopify.normalizeOrder(fake.orderPayload({ total_price: "1.005" }))).toBeNull();
  });
});

describe("product publish", () => {
  const input = {
    title: "Creatine",
    descriptionHtml: "<p>x</p>",
    externalProductId: null,
    variants: [
      { sku: "S-1", priceMinor: 2999n, currency: "USD", title: "60 caps" },
      { sku: "S-2", priceMinor: 4999n, currency: "USD", title: "120 caps" },
    ],
    images: [{ data: new Uint8Array([1, 2, 3]), mime: "image/png", filename: "m.png" }],
  };

  it("creates, then updates in place keeping variant ids", async () => {
    const first = await shopify.pushProduct(conn, input);
    const stored = fake.shop(SHOP).products.get(Number(first.externalProductId))!;
    expect(stored.variants.map((v) => v.price)).toEqual(["29.99", "49.99"]);
    expect(stored.images).toHaveLength(1);

    const second = await shopify.pushProduct(conn, {
      ...input,
      externalProductId: first.externalProductId,
      variants: input.variants.map((v, i) => ({
        ...v,
        priceMinor: v.priceMinor + 100n,
        externalVariantId: first.variants[i]!.externalVariantId,
      })),
    });
    expect(second).toEqual(first);
    expect(fake.shop(SHOP).products.size).toBe(1);
  });

  it("recreates a product deleted in the store", async () => {
    const first = await shopify.pushProduct(conn, input);
    fake.shop(SHOP).products.clear();
    const again = await shopify.pushProduct(conn, {
      ...input,
      externalProductId: first.externalProductId,
    });
    expect(again.externalProductId).not.toBe(first.externalProductId);
  });
});

describe("orders polling", () => {
  it("follows Link-header pagination and reports the high-water mark", async () => {
    fake.pageSize = 2;
    const base = Date.parse("2026-09-01T00:00:00Z");
    for (let i = 0; i < 5; i++)
      fake.addOrder(
        SHOP,
        fake.orderPayload({ updated_at: new Date(base + i * 60_000).toISOString() }),
      );
    fake.addOrder(SHOP, fake.orderPayload({ updated_at: "2026-08-01T00:00:00Z" }));
    const out = await shopify.fetchOrderUpdatesSince(conn, new Date(base));
    expect(out.orders).toHaveLength(5);
    expect(out.maxUpdatedAt).toEqual(new Date(base + 4 * 60_000));
    expect(fake.requests.filter((r) => r.path.includes("/orders.json"))).toHaveLength(3);
    expect(await shopify.fetchOrdersUpdatedSince(conn, new Date(base))).toHaveLength(5);
  });
});

describe("pushFulfillment", () => {
  const push = (order: { id: number; line_items: { id: number }[] }, number: string, qty = 1) => ({
    externalOrderId: String(order.id),
    lines: [{ externalLineItemId: String(order.line_items[0]!.id), quantity: qty }],
    tracking: { number, carrier: "UPS", url: null },
    idempotencyKey: `shipment-${number}`,
  });

  it("is idempotent: the same tracking number never creates a second fulfillment", async () => {
    const order = fake.addOrder(SHOP, fake.orderPayload());
    const a = await shopify.pushFulfillment(conn, push(order, "1Z1"));
    const b = await shopify.pushFulfillment(conn, push(order, "1Z1"));
    expect(b).toEqual(a);
    expect(fake.shop(SHOP).fulfillments).toHaveLength(1);
  });

  it("supports partial shipments and refuses to over-fulfill", async () => {
    const order = fake.addOrder(SHOP, fake.orderPayload());
    await shopify.pushFulfillment(conn, push(order, "T1", 1));
    await shopify.pushFulfillment(conn, push(order, "T2", 1));
    expect(fake.shop(SHOP).fulfillments).toHaveLength(2);
    await expect(shopify.pushFulfillment(conn, push(order, "T3", 1))).rejects.toThrow(
      /no fulfillable quantity/,
    );
  });

  it("a revoked token surfaces as ProviderAuthError without leaking the token", async () => {
    const order = fake.addOrder(SHOP, fake.orderPayload());
    fake.revokeToken(SHOP);
    const err = await shopify.pushFulfillment(conn, push(order, "T9")).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(String(err.message)).not.toContain(conn.accessToken);
  });
});

describe("webhook subscriptions", () => {
  it("subscribes each handled topic once", async () => {
    await shopify.subscribeWebhooks(conn, "https://app.test/api/webhooks/shopify");
    await shopify.subscribeWebhooks(conn, "https://app.test/api/webhooks/shopify");
    expect(
      fake
        .shop(SHOP)
        .webhooks.map((w) => w.topic)
        .sort(),
    ).toEqual([
      "app/uninstalled",
      "orders/cancelled",
      "orders/create",
      "orders/paid",
      "orders/updated",
    ]);
  });
});
