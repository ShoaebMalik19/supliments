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
import { normalizeShopifyPrivacyRequest } from "./privacy";
import { minorToDecimal } from "./money";
import { normalizeShopifyOrder } from "./normalize";

export { decimalToMinor, minorToDecimal } from "./money";

export const SHOPIFY_API_VERSION = "2026-07";

/** Days until Shopify stops serving the pinned version (each is supported for 12 months). */
export function apiVersionSupportDaysLeft(now = Date.now(), version = SHOPIFY_API_VERSION) {
  const m = /^(\d{4})-(01|04|07|10)$/.exec(version);
  if (!m) return -Infinity;
  const ends = Date.UTC(Number(m[1]) + 1, Number(m[2]) - 1, 1);
  return Math.floor((ends - now) / 86_400_000);
}

/** Minimal scopes for what v1 does: publish products, read orders, fulfill merchant-managed orders. */
export const DEFAULT_SHOPIFY_SCOPES =
  "write_products,read_orders,write_merchant_managed_fulfillment_orders,read_publications,write_publications";

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
  "customers/data_request": "privacy",
  "customers/redact": "privacy",
  "shop/redact": "privacy",
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

const STAGED_UPLOAD_HOSTS = new Set(["shopify-staged-uploads.storage.googleapis.com"]);
const gid = (type: string, id: string) => `gid://shopify/${type}/${id}`;
const gidTail = (g: string) => g.slice(g.lastIndexOf("/") + 1);

export class ShopifyUserError extends Error {
  constructor(
    readonly operation: string,
    readonly messages: string[],
  ) {
    super(`shopify ${operation}: ${messages.join("; ").slice(0, 400)}`);
    this.name = "ShopifyUserError";
  }
}

type UserErrors = { field?: string[] | null; message: string }[];

async function graphql<T>(conn: StoreConnection, query: string, variables: object): Promise<T> {
  const r = await api(conn, "POST", "graphql.json", { query, variables });
  const body = r.body as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length || !body.data)
    throw new Error(
      `shopify graphql: ${(body.errors ?? [{ message: "no data" }]).map((e) => e.message).join("; ")}`.slice(
        0,
        400,
      ),
    );
  return body.data;
}

const STAGED_UPLOADS = `mutation stage($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

/** Uploads images through Shopify's staged-upload targets; returns each file's resourceUrl. */
async function stageImages(conn: StoreConnection, images: PublishProductInput["images"]) {
  if (!images.length) return [];
  const data = await graphql<{
    stagedUploadsCreate: {
      stagedTargets: {
        url: string;
        resourceUrl: string;
        parameters: { name: string; value: string }[];
      }[];
      userErrors: UserErrors;
    };
  }>(conn, STAGED_UPLOADS, {
    input: images.map((img) => ({
      filename: img.filename,
      mimeType: img.mime,
      resource: "PRODUCT_IMAGE",
      httpMethod: "POST",
      fileSize: String(img.data.length),
    })),
  });
  const { stagedTargets, userErrors } = data.stagedUploadsCreate;
  if (userErrors.length)
    throw new ShopifyUserError(
      "stagedUploadsCreate",
      userErrors.map((e) => e.message),
    );
  if (stagedTargets.length !== images.length)
    throw new Error("shopify stagedUploadsCreate returned the wrong number of targets");
  return Promise.all(
    stagedTargets.map(async (target, i) => {
      const host = new URL(target.url).host;
      if (host !== conn.shop && !STAGED_UPLOAD_HOSTS.has(host))
        throw new Error(`refusing staged upload to unexpected host ${host}`);
      const img = images[i]!;
      const form = new FormData();
      for (const p of target.parameters) form.append(p.name, p.value);
      form.append("file", new Blob([Buffer.from(img.data)], { type: img.mime }), img.filename);
      const res = await doFetch(target.url, { method: "POST", body: form });
      if (!res.ok) throw new ShopifyHttpError(res.status, "staged upload");
      return { resourceUrl: target.resourceUrl, filename: img.filename };
    }),
  );
}

const PRODUCT_SET = `mutation publish($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
  productSet(synchronous: true, input: $input, identifier: $identifier) {
    product { id variants(first: 100) { nodes { id sku inventoryItem { id } } } }
    userErrors { field message }
  }
}`;

type ProductSetResult = {
  productSet: {
    product: {
      id: string;
      variants: {
        nodes: { id: string; sku: string | null; inventoryItem: { id: string } | null }[];
      };
    } | null;
    userErrors: UserErrors;
  };
};

const OPTION = "Variant";

function productSetInput(
  p: PublishProductInput,
  files: { resourceUrl: string; filename: string }[],
  keepVariantIds: boolean,
) {
  return {
    title: p.title,
    descriptionHtml: p.descriptionHtml ?? "",
    status: "ACTIVE",
    productOptions: [{ name: OPTION, values: p.variants.map((v) => ({ name: v.title })) }],
    files: files.map((f) => ({
      originalSource: f.resourceUrl,
      filename: f.filename,
      contentType: "IMAGE",
    })),
    variants: p.variants.map((v, i) => ({
      ...(keepVariantIds && v.externalVariantId
        ? { id: gid("ProductVariant", v.externalVariantId) }
        : {}),
      position: i + 1,
      optionValues: [{ optionName: OPTION, name: v.title }],
      sku: v.sku,
      price: minorToDecimal(v.priceMinor),
      inventoryItem: { tracked: false },
    })),
  };
}

const ONLINE_STORE = `{ publications(first: 25) { nodes { id name } } }`;
const PUBLISH = `mutation pub($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) { userErrors { field message } }
}`;

/**
 * GraphQL-created products are on no sales channel; put a new product on the Online Store.
 * Best-effort: the product already exists, so a failure here is logged, never thrown (a retry
 * would otherwise create a duplicate).
 */
async function publishToOnlineStore(conn: StoreConnection, productGid: string) {
  try {
    const { publications } = await graphql<{
      publications: { nodes: { id: string; name: string }[] };
    }>(conn, ONLINE_STORE, {});
    const store = publications.nodes.find((p) => p.name === "Online Store");
    if (!store) throw new Error("no Online Store sales channel");
    const out = await graphql<{ publishablePublish: { userErrors: UserErrors } }>(conn, PUBLISH, {
      id: productGid,
      input: [{ publicationId: store.id }],
    });
    if (out.publishablePublish.userErrors.length)
      throw new ShopifyUserError(
        "publishablePublish",
        out.publishablePublish.userErrors.map((e) => e.message),
      );
  } catch (e) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "shopify_online_store_publish_failed",
        shop: conn.shop,
        message: (e as Error).message.slice(0, 300),
      }),
    );
  }
}

/**
 * Creates or updates the product with GraphQL `productSet` (images via staged uploads). Ids are
 * stored as the numeric tail of Shopify's GIDs, the same ids order payloads carry. A product
 * deleted in the store is recreated.
 */
async function pushProduct(
  conn: StoreConnection,
  p: PublishProductInput,
): Promise<PublishedProduct> {
  const files = await stageImages(conn, p.images);
  const run = async (update: boolean) =>
    (
      await graphql<ProductSetResult>(conn, PRODUCT_SET, {
        input: productSetInput(p, files, update),
        identifier: update ? { id: gid("Product", p.externalProductId!) } : undefined,
      })
    ).productSet;
  let out = p.externalProductId ? await run(true) : null;
  if (out && !out.product && out.userErrors.some((e) => /not (exist|found)/i.test(e.message)))
    out = null;
  const created = !out;
  if (!out) out = await run(false);
  if (out.userErrors.length || !out.product)
    throw new ShopifyUserError(
      "productSet",
      out.userErrors.map((e) => e.message),
    );
  if (created) await publishToOnlineStore(conn, out.product.id);
  const bySku = new Map(out.product.variants.nodes.map((v) => [v.sku ?? "", v]));
  return {
    externalProductId: gidTail(out.product.id),
    variants: p.variants.map((v) => {
      const got = bySku.get(v.sku);
      if (!got) throw new Error(`shopify did not return variant for sku ${v.sku}`);
      return {
        sku: v.sku,
        externalVariantId: gidTail(got.id),
        externalInventoryItemId: got.inventoryItem ? gidTail(got.inventoryItem.id) : null,
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
  normalizePrivacyRequest: normalizeShopifyPrivacyRequest,
  pushProduct,
  async fetchOrdersUpdatedSince(conn, since) {
    return (await fetchOrderUpdatesSince(conn, since)).orders;
  },
  fetchOrderUpdatesSince,
  async fetchOrder(conn, externalOrderId) {
    if (!/^\d{1,20}$/.test(externalOrderId)) return null;
    try {
      const r = await api(conn, "GET", `orders/${externalOrderId}.json?status=any`);
      return normalizeShopifyOrder((r.body as { order: unknown }).order);
    } catch (e) {
      if (e instanceof ShopifyHttpError && e.status === 404) return null;
      throw e;
    }
  },
  pushFulfillment,
};
