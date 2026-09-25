import { eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { integrations, stores } from "@/db/schema";
import { encryptSecret } from "@/modules/integrations/secrets";
import * as installRoute from "@/app/api/integrations/shopify/install/route";
import * as callbackRoute from "@/app/api/integrations/shopify/callback/route";
import type { FakeSession } from "./fake-session";
import type { FakeShopify } from "./fake-shopify";
import type { createTenant } from "./helpers";

type Tenant = Awaited<ReturnType<typeof createTenant>>;

const get = (
  handler: (req: Request, a: { params: Promise<object> }) => Promise<Response>,
  url: string,
) => handler(new Request(url), { params: Promise.resolve({}) });

/** Hits the install route as `user` and returns the raw state from the authorize redirect. */
export async function beginInstall(tenant: Tenant, shop: string, brandId = tenant.brand.id) {
  const res = await get(
    installRoute.GET,
    `http://test/api/integrations/shopify/install?shop=${shop}&brandId=${brandId}`,
  );
  const location = res.headers.get("location");
  return { res, state: location ? new URL(location).searchParams.get("state") : null };
}

export const callbackUrl = (q: URLSearchParams) =>
  `http://test/api/integrations/shopify/callback?${q}`;

export async function finishInstall(query: URLSearchParams) {
  return get(callbackRoute.GET, callbackUrl(query));
}

/**
 * Full OAuth connect through the real routes (install → signed callback), acting as the
 * tenant owner. Returns the callback response and the integration row (if one was created).
 */
export async function connectShopify(
  fake: FakeShopify,
  session: FakeSession,
  tenant: Tenant,
  shop: string,
) {
  if (!fake.shops.has(shop)) fake.createShop(shop);
  session.actAs(tenant.owner);
  const { state } = await beginInstall(tenant, shop);
  const res = await finishInstall(fake.callbackQuery({ shop, state: state! }));
  const [integration] = await privilegedDb()
    .select()
    .from(integrations)
    .where(eq(integrations.externalShopId, shop));
  return { res, integration: integration ?? null };
}

/**
 * Seeds a connected Shopify integration + store row directly (no HTTP), with a token the fake
 * accepts. For tests that start after connect (fulfillment push, order sync, E2E).
 */
export async function seedShopifyIntegration(fake: FakeShopify, tenant: Tenant, shop: string) {
  const fakeShop = fake.shops.get(shop) ?? fake.createShop(shop);
  const token = `shpat_${Math.random().toString(36).slice(2)}`;
  fakeShop.accessToken = token;
  const secret = encryptSecret(token);
  const [integration] = await privilegedDb()
    .insert(integrations)
    .values({
      orgId: tenant.org.id,
      brandId: tenant.brand.id,
      provider: "shopify",
      externalShopId: shop,
      domain: shop,
      status: "connected",
      scopes: ["write_products", "read_orders"],
      credentialsCiphertext: secret.ciphertext,
      credentialsKeyId: secret.keyId,
      installedAt: new Date(),
    })
    .returning();
  const [store] = await privilegedDb()
    .insert(stores)
    .values({
      orgId: tenant.org.id,
      integrationId: integration!.id,
      brandId: tenant.brand.id,
      domain: shop,
      currency: fakeShop.currency,
    })
    .returning();
  return { integration: integration!, store: store!, token };
}

let shopSeq = 0;
export const uniqueShop = (prefix = "store") =>
  `${prefix}-${Date.now().toString(36)}-${++shopSeq}.myshopify.com`;
