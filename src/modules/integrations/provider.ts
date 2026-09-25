import type { ExternalOrder } from "@/modules/orders/external";

/** Decrypted credentials, only ever materialised inside the integrations module. */
export type StoreConnection = { shop: string; accessToken: string };

export type PublishProductInput = {
  title: string;
  descriptionHtml: string | null;
  /** Existing external product id when re-publishing. */
  externalProductId: string | null;
  variants: { sku: string; priceMinor: bigint; currency: string; title: string }[];
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

/** Store-platform integration (§9). Shopify is the only implementation. */
export interface CommerceProvider {
  readonly key: "shopify";
  normalizeShop(input: string): string | null;
  authorizeUrl(shop: string, state: string, redirectUri: string): string;
  /** Verifies the callback signature, then exchanges the code. Returns null if verification fails. */
  completeAuthorization(
    query: URLSearchParams,
  ): Promise<{ shop: string; accessToken: string; scopes: string[] } | null>;
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  webhookMeta(headers: Headers): { topic: string; shop: string; eventId: string } | null;
  normalizeOrder(payload: unknown): ExternalOrder | null;
  pushProduct(conn: StoreConnection, product: PublishProductInput): Promise<PublishedProduct>;
  fetchOrdersUpdatedSince(conn: StoreConnection, since: Date): Promise<ExternalOrder[]>;
  pushFulfillment(
    conn: StoreConnection,
    push: FulfillmentPush,
  ): Promise<{ externalFulfillmentId: string }>;
}
