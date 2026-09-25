import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { privilegedDb } from "@/db/privileged";
import { brandProducts, integrations, jobQueue, oauthStates, webhookEvents } from "@/db/schema";
import { setShopifyFetchForTests } from "@/adapters/shopify";
import * as publishRoute from "@/app/api/brand-products/[id]/publish/route";
import * as webhookRoute from "@/app/api/webhooks/shopify/route";
import { FakeShopify } from "../fake-shopify";
import { seedBrandProduct } from "../helpers";
import {
  beginInstall,
  finishInstall,
  seedShopifyIntegration,
  uniqueShop,
} from "../shopify-helpers";
import type { TenantRouteCase, UnscopedCheckContext, UnscopedRouteCase } from "./routes";

const fake = new FakeShopify();

async function publishJobs(brandProductId: string) {
  return privilegedDb()
    .select({ id: jobQueue.id, orgId: jobQueue.orgId })
    .from(jobQueue)
    .where(sql`${jobQueue.payload}->>'brandProductId' = ${brandProductId}`);
}

export const shopifyTenantRoutes: TenantRouteCase[] = [
  {
    file: "src/app/api/brand-products/[id]/publish/route.ts",
    url: (id) => `http://test/api/brand-products/${id}/publish`,
    seed: async (b) => {
      await seedShopifyIntegration(fake, b, uniqueShop("iso"));
      const { brandProduct } = await seedBrandProduct(b);
      await privilegedDb()
        .update(brandProducts)
        .set({ status: "approved" })
        .where(eq(brandProducts.id, brandProduct.id));
      return brandProduct.id;
    },
    snapshot: async (id) => ({
      product: (
        await privilegedDb().select().from(brandProducts).where(eq(brandProducts.id, id))
      )[0],
      jobs: await publishJobs(id),
    }),
    read: [],
    mutate: [{ method: "POST", handler: publishRoute.POST, body: {} }],
  },
];

export const shopifyUnscopedRoutes: UnscopedRouteCase[] = [
  {
    file: "src/app/api/integrations/shopify/install/route.ts",
    reason: "create-only: the OAuth state is written to the caller's org for the caller's brand",
    check: async ({ A, B }: UnscopedCheckContext) => {
      const shop = uniqueShop("iso-install");
      expect((await beginInstall(A, shop, B.brand.id)).res.status).toBe(404);
      expect((await beginInstall(A, shop)).res.status).toBe(302);
      const rows = await privilegedDb()
        .select()
        .from(oauthStates)
        .where(eq(oauthStates.shop, shop));
      expect(rows.map((r) => [r.orgId, r.createdBy])).toEqual([[A.org.id, A.owner.id]]);
    },
  },
  {
    file: "src/app/api/integrations/shopify/callback/route.ts",
    reason: "no row id in the URL; the state is resolved under RLS and must be the caller's",
    check: async ({ A, B, actAs }: UnscopedCheckContext) => {
      setShopifyFetchForTests(fake.fetch);
      const shop = uniqueShop("iso-callback");
      fake.createShop(shop);
      actAs(B.owner);
      const { state } = await beginInstall(B, shop);
      actAs(A.owner);
      const res = await finishInstall(fake.callbackQuery({ shop, state: state! }));
      expect(res.status).toBe(404);
      const created = await privilegedDb()
        .select()
        .from(integrations)
        .where(eq(integrations.externalShopId, shop));
      expect(created).toEqual([]);
      setShopifyFetchForTests(null);
    },
  },
];

export type ExemptRouteCase = {
  file: string;
  /** Why the route cannot run under tenantRoute (no session), and what authenticates it instead. */
  reason: string;
  check: (ctx: UnscopedCheckContext) => Promise<void>;
};

/** API routes that touch tenant data WITHOUT a session. Each must prove where data can land. */
export const exemptTenantRoutes: ExemptRouteCase[] = [
  {
    file: "src/app/api/webhooks/shopify/route.ts",
    reason:
      "Shopify calls it with no user session. Authenticated by HMAC over the raw body; the org is " +
      "never read from the request, only derived from the integration that owns the shop domain",
    check: async ({ A, B }: UnscopedCheckContext) => {
      const shopA = uniqueShop("iso-hook-a");
      const shopB = uniqueShop("iso-hook-b");
      const { integration: ia } = await seedShopifyIntegration(fake, A, shopA);
      const { integration: ib } = await seedShopifyIntegration(fake, B, shopB);
      const deliver = async (shop: string, payload: unknown, extra: object = {}) => {
        const eventId = `iso-${Math.random().toString(36).slice(2)}`;
        const res = await webhookRoute.POST(
          fake.webhookRequest({ topic: "orders/paid", shop, payload, eventId, ...extra }),
        );
        const [ev] = await privilegedDb()
          .select()
          .from(webhookEvents)
          .where(eq(webhookEvents.dedupeKey, `shopify:${eventId}`));
        const jobs = ev
          ? await privilegedDb()
              .select({ orgId: jobQueue.orgId })
              .from(jobQueue)
              .where(sql`${jobQueue.payload}->>'webhookEventId' = ${ev.id}`)
          : [];
        return { status: res.status, ev, jobs };
      };

      const forged = { ...fake.orderPayload(), org_id: B.org.id, integration_id: ib.id };
      const a = await deliver(shopA, forged);
      expect(a.status).toBe(200);
      expect(a.ev!.integrationId).toBe(ia.id);
      expect(a.jobs).toEqual([{ orgId: A.org.id }]);

      const b = await deliver(shopB, fake.orderPayload());
      expect(b.ev!.integrationId).toBe(ib.id);
      expect(b.jobs).toEqual([{ orgId: B.org.id }]);

      const unsigned = await deliver(shopB, fake.orderPayload(), { secret: "attacker" });
      expect(unsigned.status).toBe(401);
      expect(unsigned.ev).toBeUndefined();
    },
  },
];
