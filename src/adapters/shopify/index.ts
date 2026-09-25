import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ProviderAuthError,
  type CommerceProvider,
  type FulfillmentPush,
  type OrderUpdates,
  type PublishProductInput,
  type PublishedProduct,
  type StoreConnection,
  type WebhookKind,
} from "@/modules/integrations/provider";
import type { ExternalOrder } from "@/modules/orders/external";
import { minorToDecimal } from "./money";
import { normalizeShopifyOrder } from "./normalize";

export { decimalToMinor, minorToDecimal } from "./money";

export const SHOPIFY_API_VERSION = "2025-07";

/** Minimal scopes for what v1 does: publish products, read orders, fulfill merchant-managed orders. */
export const DEFAULT_SHOPIFY_SCOPES =
  "write_products,read_orders,write_merchant_managed_fulfillment_orders";

export const SHOPIFY_WEBHOOK_TOPICS = [
  "orders/create",
  "orders/paid",
  "orders/updated",
  "orders/cancelled",
  "app/uninstalled",
] as const;

const TOPIC_KIND: Record<string, WebhookKind> = {
  "orders/create": "order",
  "orders/paid": "order",
  "orders/updated": "order",
  "orders/cancelled": "order",
  "app/uninstalled": "app_uninstalled",
};

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

type FetchFn = typeof fetch;
let fetchImpl: FetchFn | null = null;

/** Routes every Shopify HTTP call through `f` (tests pass FakeShopify.fetch); null restores fetch. */
export function setShopifyFetchForTests(f: FetchFn | null) {
  fetchImpl = f;
}

const doFetch: FetchFn = (input, init) => (fetchImpl ?? fetch)(input, init);

function config() {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("SHOPIFY_API_KEY / SHOPIFY_API_SECRET are not set");
  return { apiKey, apiSecret, scopes: process.env.SHOPIFY_SCOPES || DEFAULT_SHOPIFY_SCOPES };
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function normalizeShop(input: string): string | null {
  const s = input.trim().toLowerCase();
  return SHOP_RE.test(s) && s.length <= 255 ? s : null;
}

/** Shopify OAuth query signature: hex HMAC-SHA256 over the sorted `k=v` pairs minus `hmac`. */
export function callbackMessage(query: URLSearchParams) {
  return [...query.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function verifyCallback(query: URLSearchParams): boolean {
  const hmac = query.get("hmac");
  const shop = query.get("shop");
  if (!hmac || !shop || !normalizeShop(shop)) return false;
  const want = createHmac("sha256", config().apiSecret)
    .update(callbackMessage(query))
    .digest("hex");
  return safeEqual(hmac.toLowerCase(), want);
}

function verifyWebhook(rawBody: string, headers: Headers): boolean {
  const got = headers.get("x-shopify-hmac-sha256");
  if (!got) return false;
  const want = createHmac("sha256", config().apiSecret).update(rawBody, "utf8").digest("base64");
  return safeEqual(got, want);
}

export class ShopifyHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`shopify ${path} failed with HTTP ${status}`);
    this.name = "ShopifyHttpError";
  }
}

type Api = { body: unknown; headers: Headers };

async function api(
  conn: StoreConnection,
  method: string,
  pathOrUrl: string,
  body?: unknown,
): Promise<Api> {
  const url = pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `https://${conn.shop}/admin/api/${SHOPIFY_API_VERSION}/${pathOrUrl}`;
  if (new URL(url).host !== conn.shop) throw new Error("refusing request to a foreign host");
  const res = await doFetch(url, {
    method,
    headers: {
      "x-shopify-access-token": conn.accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const path = new URL(url).pathname;
  if (res.status === 401) throw new ProviderAuthError(`shopify ${path} returned 401`);
  if (!res.ok) throw new ShopifyHttpError(res.status, path);
  const text = await res.text();
  return { body: text ? JSON.parse(text) : null, headers: res.headers };
}

function nextLink(headers: Headers): string | null {
  const link = headers.get("link");
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

type ShopifyVariant = {
  id: number | string;
  sku: string | null;
  inventory_item_id?: number | null;
};
type ShopifyProduct = { id: number | string; variants: ShopifyVariant[] };

function productBody(p: PublishProductInput) {
  return {
    title: p.title,
    body_html: p.descriptionHtml ?? "",
    options: [{ name: "Variant" }],
    variants: p.variants.map((v) => ({
      ...(v.externalVariantId ? { id: Number(v.externalVariantId) } : {}),
      sku: v.sku,
      price: minorToDecimal(v.priceMinor),
      option1: v.title,
      inventory_management: null,
    })),
    images: p.images.map((img) => ({
      attachment: Buffer.from(img.data).toString("base64"),
      filename: img.filename,
    })),
  };
}

async function pushProduct(
  conn: StoreConnection,
  p: PublishProductInput,
): Promise<PublishedProduct> {
  let product: ShopifyProduct | null = null;
  if (p.externalProductId) {
    try {
      const r = await api(conn, "PUT", `products/${encodeURIComponent(p.externalProductId)}.json`, {
        product: { id: Number(p.externalProductId), ...productBody(p) },
      });
      product = (r.body as { product: ShopifyProduct }).product;
    } catch (e) {
      if (!(e instanceof ShopifyHttpError && e.status === 404)) throw e;
    }
  }
  if (!product) {
    const fresh = { ...p, variants: p.variants.map((v) => ({ ...v, externalVariantId: null })) };
    const r = await api(conn, "POST", "products.json", { product: productBody(fresh) });
    product = (r.body as { product: ShopifyProduct }).product;
  }
  const bySku = new Map(product.variants.map((v) => [v.sku ?? "", v]));
  return {
    externalProductId: String(product.id),
    variants: p.variants.map((v) => {
      const got = bySku.get(v.sku);
      if (!got) throw new Error(`shopify did not return variant for sku ${v.sku}`);
      return {
        sku: v.sku,
        externalVariantId: String(got.id),
        externalInventoryItemId: got.inventory_item_id ? String(got.inventory_item_id) : null,
      };
    }),
  };
}

async function fetchOrderUpdatesSince(conn: StoreConnection, since: Date): Promise<OrderUpdates> {
  const orders: ExternalOrder[] = [];
  let maxUpdatedAt: Date | null = null;
  const qs = new URLSearchParams({
    status: "any",
    updated_at_min: since.toISOString(),
    limit: "250",
  });
  let next: string | null = `orders.json?${qs}`;
  for (let page = 0; next && page < 400; page++) {
    const r = await api(conn, "GET", next);
    for (const raw of (r.body as { orders: { updated_at?: string }[] }).orders) {
      const updated = raw.updated_at ? new Date(raw.updated_at) : null;
      if (updated && !isNaN(+updated) && (!maxUpdatedAt || updated > maxUpdatedAt))
        maxUpdatedAt = updated;
      const o = normalizeShopifyOrder(raw);
      if (o) orders.push(o);
    }
    next = nextLink(r.headers);
  }
  return { orders, maxUpdatedAt };
}

type ShopifyFulfillment = {
  id: number | string;
  status: string;
  tracking_number?: string | null;
  tracking_numbers?: string[] | null;
};

type FulfillmentOrder = {
  id: number | string;
  status: string;
  line_items: {
    id: number | string;
    line_item_id: number | string;
    fulfillable_quantity: number;
  }[];
};

async function pushFulfillment(
  conn: StoreConnection,
  push: FulfillmentPush,
): Promise<{ externalFulfillmentId: string }> {
  const orderId = encodeURIComponent(push.externalOrderId);
  const existing = await api(conn, "GET", `orders/${orderId}/fulfillments.json`);
  const same = (existing.body as { fulfillments: ShopifyFulfillment[] }).fulfillments.find(
    (f) =>
      f.status !== "cancelled" &&
      (f.tracking_number === push.tracking.number ||
        (f.tracking_numbers ?? []).includes(push.tracking.number)),
  );
  if (same) return { externalFulfillmentId: String(same.id) };

  const fo = await api(conn, "GET", `orders/${orderId}/fulfillment_orders.json`);
  const open = (fo.body as { fulfillment_orders: FulfillmentOrder[] }).fulfillment_orders.filter(
    (f) => f.status === "open" || f.status === "in_progress",
  );
  const byFo = new Map<string, { id: number; quantity: number }[]>();
  for (const line of push.lines) {
    let remaining = line.quantity;
    for (const f of open) {
      for (const li of f.line_items) {
        if (remaining === 0) break;
        if (String(li.line_item_id) !== line.externalLineItemId || li.fulfillable_quantity <= 0)
          continue;
        const take = Math.min(remaining, li.fulfillable_quantity);
        li.fulfillable_quantity -= take;
        remaining -= take;
        const list = byFo.get(String(f.id)) ?? [];
        list.push({ id: Number(li.id), quantity: take });
        byFo.set(String(f.id), list);
      }
    }
    if (remaining > 0)
      throw new Error(`line ${line.externalLineItemId} has no fulfillable quantity left`);
  }

  const r = await api(conn, "POST", "fulfillments.json", {
    fulfillment: {
      line_items_by_fulfillment_order: [...byFo].map(([id, items]) => ({
        fulfillment_order_id: Number(id),
        fulfillment_order_line_items: items,
      })),
      tracking_info: {
        number: push.tracking.number,
        company: push.tracking.carrier,
        ...(push.tracking.url ? { url: push.tracking.url } : {}),
      },
      notify_customer: true,
    },
  });
  return {
    externalFulfillmentId: String(
      (r.body as { fulfillment: { id: number | string } }).fulfillment.id,
    ),
  };
}

async function subscribeWebhooks(conn: StoreConnection, address: string) {
  const r = await api(conn, "GET", "webhooks.json?limit=250");
  const have = new Set(
    (r.body as { webhooks: { topic: string; address: string }[] }).webhooks
      .filter((w) => w.address === address)
      .map((w) => w.topic),
  );
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    if (have.has(topic)) continue;
    await api(conn, "POST", "webhooks.json", { webhook: { topic, address, format: "json" } });
  }
}

export const shopify: CommerceProvider = {
  key: "shopify",
  normalizeShop,

  authorizeUrl(shop, state, redirectUri) {
    const q = new URLSearchParams({
      client_id: config().apiKey,
      scope: config().scopes,
      redirect_uri: redirectUri,
      state,
    });
    return `https://${shop}/admin/oauth/authorize?${q}`;
  },

  verifyCallback,

  async completeAuthorization(query) {
    if (!verifyCallback(query)) return null;
    const shop = normalizeShop(query.get("shop") ?? "");
    const code = query.get("code");
    if (!shop || !code) return null;
    const { apiKey, apiSecret } = config();
    const res = await doFetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: string; scope?: string };
    if (!body.access_token) return null;
    return {
      shop,
      accessToken: body.access_token,
      scopes: (body.scope ?? "").split(",").filter(Boolean),
    };
  },

  async fetchShopInfo(conn) {
    const r = await api(conn, "GET", "shop.json");
    const shop = (r.body as { shop: { currency: string; name?: string | null } }).shop;
    return { currency: shop.currency.toUpperCase(), name: shop.name ?? null };
  },

  subscribeWebhooks,
  verifyWebhook,

  webhookMeta(headers) {
    const topic = headers.get("x-shopify-topic");
    const shop = normalizeShop(headers.get("x-shopify-shop-domain") ?? "");
    const eventId = headers.get("x-shopify-event-id") ?? headers.get("x-shopify-webhook-id");
    if (!topic || !shop || !eventId) return null;
    return { topic, kind: TOPIC_KIND[topic] ?? "other", shop, eventId };
  },

  normalizeOrder: normalizeShopifyOrder,
  pushProduct,
  async fetchOrdersUpdatedSince(conn, since) {
    return (await fetchOrderUpdatesSince(conn, since)).orders;
  },
  fetchOrderUpdatesSince,
  pushFulfillment,
};
