import type { ExternalOrder } from "@/modules/orders/external";

/** Decrypted credentials, only ever materialised inside the integrations module. */
export type StoreConnection = { shop: string; accessToken: string };

export type PublishProductInput = {
  title: string;
  descriptionHtml: string | null;
  /** Existing external product id when re-publishing. */
  externalProductId: string | null;
  variants: {
    sku: string;
    priceMinor: bigint;
    currency: string;
    title: string;
    /** Existing external variant id when re-publishing (keeps the store's variant, and its orders' mapping). */
    externalVariantId?: string | null;
  }[];
  images: { data: Uint8Array; mime: string; filename: string }[];
};

export type PublishedProduct = {
  externalProductId: string;
  variants: { sku: string; externalVariantId: string; externalInventoryItemId: string | null }[];
};

export type FulfillmentPush = {
  externalOrderId: string;
  lines: { externalLineItemId: string; quantity: number }[];
  tracking: { number: string; carrier: string; url: string | null };
  /** Stable per shipment; adapters must make a repeated push a no-op. */
  idempotencyKey: string;
};

export type WebhookKind = "order" | "app_uninstalled" | "other";

export type OrderUpdates = {
  orders: ExternalOrder[];
  /** Highest store-side `updated_at` seen (including orders that normalized to nothing). */
  maxUpdatedAt: Date | null;
};

export type ShopInfo = { currency: string; name: string | null };

/** The store rejected our token (401): the integration needs re-authorization (§9.7). */
export class ProviderAuthError extends Error {
  constructor(message = "store rejected credentials") {
    super(message);
    this.name = "ProviderAuthError";
  }
}

/** Store-platform integration (§9). Shopify is the only implementation. */
export interface CommerceProvider {
  readonly key: "shopify";
  normalizeShop(input: string): string | null;
  authorizeUrl(shop: string, state: string, redirectUri: string): string;
  /** Signature check of the OAuth callback query only (no network). */
  verifyCallback(query: URLSearchParams): boolean;
  /** Verifies the callback signature, then exchanges the code. Returns null if verification fails. */
  completeAuthorization(
    query: URLSearchParams,
  ): Promise<{ shop: string; accessToken: string; scopes: string[] } | null>;
  fetchShopInfo(conn: StoreConnection): Promise<ShopInfo>;
  /** Idempotently subscribes the webhook topics we process to `address`. */
  subscribeWebhooks(conn: StoreConnection, address: string): Promise<void>;
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  webhookMeta(
    headers: Headers,
  ): { topic: string; kind: WebhookKind; shop: string; eventId: string } | null;
  normalizeOrder(payload: unknown): ExternalOrder | null;
  pushProduct(conn: StoreConnection, product: PublishProductInput): Promise<PublishedProduct>;
  fetchOrdersUpdatedSince(conn: StoreConnection, since: Date): Promise<ExternalOrder[]>;
  /** The store's own copy of one order (null if the store has no such order). */
  fetchOrder(conn: StoreConnection, externalOrderId: string): Promise<ExternalOrder | null>;
  /** Same as fetchOrdersUpdatedSince, plus the high-water mark for `orders_synced_through`. */
  fetchOrderUpdatesSince(conn: StoreConnection, since: Date): Promise<OrderUpdates>;
  pushFulfillment(
    conn: StoreConnection,
    push: FulfillmentPush,
  ): Promise<{ externalFulfillmentId: string }>;
}
