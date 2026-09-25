import { createHmac, randomBytes } from "node:crypto";
import { callbackMessage, SHOPIFY_API_VERSION } from "@/adapters/shopify";

/**
 * In-memory Shopify implementing exactly the HTTP endpoints `src/adapters/shopify` calls.
 *
 * Usage:
 *   const fake = new FakeShopify();
 *   setShopifyFetchForTests(fake.fetch);            // route adapter traffic here
 *   const shop = fake.createShop("acme.myshopify.com", { currency: "USD" });
 *   const query = fake.callbackQuery({ shop: shop.domain, state });   // signed OAuth callback
 *   fake.addOrder(shop.domain, fake.orderPayload({ line_items: [...] }));
 *   const req = fake.webhookRequest({ topic: "orders/paid", shop: shop.domain, payload });
 *   fake.revokeToken(shop.domain);                  // every API call now answers 401
 *
 * Signing uses process.env.SHOPIFY_API_SECRET (tests/setup.ts sets it) unless `secret` is given.
 * `fake.requests` records every call (method + path) for assertions.
 */

type Json = Record<string, unknown>;

export type FakeLineItem = {
  id: number;
  variant_id: number | null;
  sku: string | null;
  title: string;
  quantity: number;
  price: string;
  current_quantity?: number;
};

export type FakeOrder = Json & {
  id: number;
  updated_at: string;
  line_items: FakeLineItem[];
};

export type FakeFulfillmentOrder = {
  id: number;
  order_id: number;
  status: "open" | "in_progress" | "closed";
  line_items: { id: number; line_item_id: number; fulfillable_quantity: number }[];
};

export type FakeFulfillment = {
  id: number;
  order_id: number;
  status: "success" | "cancelled";
  tracking_number: string | null;
  tracking_numbers: string[];
  tracking_company: string | null;
  tracking_url: string | null;
  line_items_by_fulfillment_order: unknown;
};

export type FakeShop = {
  domain: string;
  currency: string;
  name: string;
  accessToken: string | null;
  codes: Map<string, string>;
  products: Map<number, Json & { id: number; variants: Json[]; images: Json[] }>;
  orders: Map<number, FakeOrder>;
  fulfillmentOrders: FakeFulfillmentOrder[];
  fulfillments: FakeFulfillment[];
  webhooks: { id: number; topic: string; address: string }[];
};

let seq = 1000;
const nextId = () => ++seq;

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export class FakeShopify {
  shops = new Map<string, FakeShop>();
  requests: { method: string; path: string }[] = [];
  /** Max orders per page for orders.json (lower it to exercise Link-header pagination). */
  pageSize = 250;

  constructor(readonly secret = process.env.SHOPIFY_API_SECRET ?? "test-api-secret") {}

  createShop(domain: string, opts: { currency?: string; name?: string } = {}): FakeShop {
    const shop: FakeShop = {
      domain,
      currency: opts.currency ?? "USD",
      name: opts.name ?? domain,
      accessToken: null,
      codes: new Map(),
      products: new Map(),
      orders: new Map(),
      fulfillmentOrders: [],
      fulfillments: [],
      webhooks: [],
    };
    this.shops.set(domain, shop);
    return shop;
  }

  shop(domain: string): FakeShop {
    const s = this.shops.get(domain);
    if (!s) throw new Error(`fake shop ${domain} not created`);
    return s;
  }

  /** Issues an OAuth code; exchanging it sets (and returns) a new access token for the shop. */
  issueCode(domain: string): { code: string; token: string } {
    const code = randomBytes(8).toString("hex");
    const token = `shpat_${randomBytes(16).toString("hex")}`;
    this.shop(domain).codes.set(code, token);
    return { code, token };
  }

  /** A correctly signed OAuth callback query (issues a fresh code unless one is given). */
  callbackQuery(p: { shop: string; state: string; code?: string; secret?: string }) {
    const q = new URLSearchParams({
      code: p.code ?? this.issueCode(p.shop).code,
      shop: p.shop,
      state: p.state,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    q.set(
      "hmac",
      createHmac("sha256", p.secret ?? this.secret)
        .update(callbackMessage(q))
        .digest("hex"),
    );
    return q;
  }

  signWebhook(rawBody: string, secret = this.secret) {
    return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  }

  /** A signed webhook delivery as Shopify would POST it to /api/webhooks/shopify. */
  webhookRequest(p: {
    topic: string;
    shop: string;
    payload: unknown;
    eventId?: string;
    secret?: string;
    hmac?: string | null;
    url?: string;
  }) {
    const body = JSON.stringify(p.payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-shopify-topic": p.topic,
      "x-shopify-shop-domain": p.shop,
      "x-shopify-api-version": SHOPIFY_API_VERSION,
      "x-shopify-event-id": p.eventId ?? randomBytes(8).toString("hex"),
      "x-shopify-webhook-id": randomBytes(8).toString("hex"),
    };
    const hmac = p.hmac === undefined ? this.signWebhook(body, p.secret) : p.hmac;
    if (hmac !== null) headers["x-shopify-hmac-sha256"] = hmac;
    return new Request(p.url ?? "http://test/api/webhooks/shopify", {
      method: "POST",
      headers,
      body,
    });
  }

  /** A realistic orders/* payload. Amounts are decimal strings, as Shopify sends them. */
  orderPayload(over: Partial<FakeOrder> = {}): FakeOrder {
    const id = over.id ?? nextId();
    const now = new Date().toISOString();
    return {
      id,
      name: `#${id}`,
      currency: "USD",
      created_at: now,
      processed_at: now,
      updated_at: now,
      financial_status: "paid",
      cancelled_at: null,
      test: false,
      email: "buyer@example.com",
      customer: {
        id: 77,
        email: "buyer@example.com",
        first_name: "Ada",
        last_name: "Buyer",
        phone: null,
      },
      shipping_address: {
        name: "Ada Buyer",
        address1: "1 Main St",
        city: "Austin",
        province: "TX",
        zip: "78701",
        country_code: "US",
      },
      billing_address: null,
      subtotal_price: "59.98",
      total_shipping_price_set: { shop_money: { amount: "4.99", currency_code: "USD" } },
      total_price: "64.97",
      line_items: [
        {
          id: nextId(),
          variant_id: 5001,
          sku: "SKU-1",
          title: "Creatine",
          quantity: 2,
          price: "29.99",
        },
      ],
      ...over,
    };
  }

  /** Stores (or replaces) an order and gives it one open fulfillment order. */
  addOrder(domain: string, order: FakeOrder): FakeOrder {
    const shop = this.shop(domain);
    shop.orders.set(order.id, order);
    if (!shop.fulfillmentOrders.some((f) => f.order_id === order.id))
      shop.fulfillmentOrders.push({
        id: nextId(),
        order_id: order.id,
        status: "open",
        line_items: order.line_items.map((li) => ({
          id: nextId(),
          line_item_id: li.id,
          fulfillable_quantity: li.current_quantity ?? li.quantity,
        })),
      });
    return order;
  }

  revokeToken(domain: string) {
    this.shop(domain).accessToken = null;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    this.requests.push({ method, path: url.pathname + url.search });
    const shop = this.shops.get(url.host);
    if (!shop) return jsonRes({ errors: "Not Found" }, 404);
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};

    if (url.pathname === "/admin/oauth/access_token" && method === "POST") {
      const token = shop.codes.get(String(body.code));
      if (!token || body.client_secret !== this.secret) return jsonRes({ error: "invalid" }, 400);
      shop.codes.delete(String(body.code));
      shop.accessToken = token;
      return jsonRes({ access_token: token, scope: "write_products,read_orders" });
    }

    const prefix = `/admin/api/${SHOPIFY_API_VERSION}/`;
    if (!url.pathname.startsWith(prefix)) return jsonRes({ errors: "Not Found" }, 404);
    const auth = new Headers(init?.headers).get("x-shopify-access-token");
    if (!shop.accessToken || auth !== shop.accessToken)
      return jsonRes({ errors: "[API] Invalid API key or access token" }, 401);
    const path = url.pathname.slice(prefix.length);
    return this.route(shop, method, path, url, body);
  };

  private route(shop: FakeShop, method: string, path: string, url: URL, body: Json): Response {
    let m: RegExpExecArray | null;
    if (path === "shop.json" && method === "GET")
      return jsonRes({
        shop: { name: shop.name, currency: shop.currency, myshopify_domain: shop.domain },
      });

    if (path === "webhooks.json" && method === "GET") return jsonRes({ webhooks: shop.webhooks });
    if (path === "webhooks.json" && method === "POST") {
      const w = body.webhook as { topic: string; address: string };
      const hook = { id: nextId(), topic: w.topic, address: w.address };
      shop.webhooks.push(hook);
      return jsonRes({ webhook: hook }, 201);
    }

    if (path === "products.json" && method === "POST")
      return jsonRes({ product: this.saveProduct(shop, nextId(), body.product as Json) }, 201);
    if ((m = /^products\/(\d+)\.json$/.exec(path)) && method === "PUT") {
      const id = Number(m[1]);
      if (!shop.products.has(id)) return jsonRes({ errors: "Not Found" }, 404);
      return jsonRes({ product: this.saveProduct(shop, id, body.product as Json) });
    }

    if (path === "orders.json" && method === "GET") return this.listOrders(shop, url);
    if ((m = /^orders\/(\d+)\/fulfillments\.json$/.exec(path)) && method === "GET") {
      const id = Number(m[1]);
      if (!shop.orders.has(id)) return jsonRes({ errors: "Not Found" }, 404);
      return jsonRes({ fulfillments: shop.fulfillments.filter((f) => f.order_id === id) });
    }
    if ((m = /^orders\/(\d+)\/fulfillment_orders\.json$/.exec(path)) && method === "GET") {
      const id = Number(m[1]);
      if (!shop.orders.has(id)) return jsonRes({ errors: "Not Found" }, 404);
      return jsonRes({
        fulfillment_orders: structuredClone(
          shop.fulfillmentOrders.filter((f) => f.order_id === id),
        ),
      });
    }
    if (path === "fulfillments.json" && method === "POST")
      return this.createFulfillment(shop, body);

    return jsonRes({ errors: "Not Found" }, 404);
  }

  private saveProduct(shop: FakeShop, id: number, input: Json) {
    const prev = shop.products.get(id);
    const variants = ((input.variants as Json[]) ?? []).map((v) => {
      const keep = prev?.variants.find((p) => v.id !== undefined && p.id === v.id);
      return {
        ...v,
        id: keep ? keep.id : nextId(),
        inventory_item_id: keep ? keep.inventory_item_id : nextId(),
        product_id: id,
      };
    });
    const images = ((input.images as Json[]) ?? []).map((img) => ({
      id: nextId(),
      filename: img.filename,
      bytes: Buffer.from(String(img.attachment ?? ""), "base64").length,
    }));
    const product = { ...prev, ...input, id, variants, images };
    shop.products.set(id, product);
    return product;
  }

  private listOrders(shop: FakeShop, url: URL) {
    const pageInfo = url.searchParams.get("page_info");
    const cursor = pageInfo
      ? (JSON.parse(Buffer.from(pageInfo, "base64url").toString()) as {
          min: string;
          offset: number;
        })
      : { min: url.searchParams.get("updated_at_min") ?? "1970-01-01T00:00:00Z", offset: 0 };
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), this.pageSize);
    const all = [...shop.orders.values()]
      .filter((o) => new Date(o.updated_at) >= new Date(cursor.min))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id - b.id);
    const page = all.slice(cursor.offset, cursor.offset + limit);
    const headers: Record<string, string> = {};
    if (cursor.offset + limit < all.length) {
      const next = Buffer.from(
        JSON.stringify({ min: cursor.min, offset: cursor.offset + limit }),
      ).toString("base64url");
      headers.link = `<https://${shop.domain}${url.pathname}?limit=${limit}&page_info=${next}>; rel="next"`;
    }
    return jsonRes({ orders: page }, 200, headers);
  }

  private createFulfillment(shop: FakeShop, body: Json) {
    const f = body.fulfillment as {
      line_items_by_fulfillment_order: {
        fulfillment_order_id: number;
        fulfillment_order_line_items: { id: number; quantity: number }[];
      }[];
      tracking_info?: { number?: string; company?: string; url?: string };
    };
    let orderId: number | null = null;
    for (const group of f.line_items_by_fulfillment_order) {
      const fo = shop.fulfillmentOrders.find((x) => x.id === group.fulfillment_order_id);
      if (!fo || fo.status === "closed")
        return jsonRes({ errors: "fulfillment order closed" }, 422);
      orderId = fo.order_id;
      for (const item of group.fulfillment_order_line_items) {
        const li = fo.line_items.find((x) => x.id === item.id);
        if (!li || li.fulfillable_quantity < item.quantity)
          return jsonRes({ errors: "invalid quantity" }, 422);
        li.fulfillable_quantity -= item.quantity;
      }
      fo.status = fo.line_items.every((x) => x.fulfillable_quantity === 0)
        ? "closed"
        : "in_progress";
    }
    const number = f.tracking_info?.number ?? null;
    const created: FakeFulfillment = {
      id: nextId(),
      order_id: orderId!,
      status: "success",
      tracking_number: number,
      tracking_numbers: number ? [number] : [],
      tracking_company: f.tracking_info?.company ?? null,
      tracking_url: f.tracking_info?.url ?? null,
      line_items_by_fulfillment_order: f.line_items_by_fulfillment_order,
    };
    shop.fulfillments.push(created);
    return jsonRes({ fulfillment: created }, 201);
  }
}
