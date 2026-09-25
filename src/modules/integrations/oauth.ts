import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { TenantDb } from "@/db/tenant";
import { integrations, oauthStates, stores } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { listBrands } from "@/modules/branding";
import { enqueue } from "@/modules/jobs";
import type { TenantContext } from "@/modules/tenancy";
import { badRequest, json, notFound } from "@/lib/http";
import { commerce, integrationView } from "./connection";
import { flagIntegrationConflict, JOB_RECONCILE, shopOwner } from "./privileged";
import { encryptSecret } from "./secrets";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function siteUrl(req: Request) {
  return (process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin).replace(/\/$/, "");
}

export const callbackPath = "/api/integrations/shopify/callback";
export const webhookPath = "/api/webhooks/shopify";

async function ownBrand(t: TenantDb, brandId: string) {
  if (!z.uuid().safeParse(brandId).success) return null;
  return (await listBrands(t)).find((b) => b.id === brandId) ?? null;
}

/**
 * Starts the Shopify install for one of the caller's brands. The state is random, carries the
 * brand id, and only its hash is stored (bound to org, user, shop, 10-minute expiry).
 */
export async function startShopifyInstall(ctx: TenantContext, t: TenantDb, req: Request) {
  const q = new URL(req.url).searchParams;
  const shop = commerce().normalizeShop(q.get("shop") ?? "");
  if (!shop) throw badRequest("shop must be a *.myshopify.com domain");
  const brand = await ownBrand(t, q.get("brandId") ?? "");
  if (!brand) return null;
  const state = `${brand.id}.${randomBytes(32).toString("base64url")}`;
  await t.insert(oauthStates, {
    provider: "shopify",
    shop,
    stateHash: sha256(state),
    createdBy: ctx.userId,
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  });
  const url = commerce().authorizeUrl(shop, state, `${siteUrl(req)}${callbackPath}`);
  return new Response(null, { status: 302, headers: { location: url } });
}

/**
 * OAuth callback. Order matters: signature → state (this org + user, unused, unexpired, same
 * shop) → hijack check → code exchange → encrypted upsert → store row → webhooks → catch-up.
 */
export async function completeShopifyInstall(ctx: TenantContext, t: TenantDb, req: Request) {
  const q = new URL(req.url).searchParams;
  const provider = commerce();
  if (!provider.verifyCallback(q)) throw badRequest("invalid signature");
  const state = q.get("state") ?? "";
  const [row] = await t.list(oauthStates, eq(oauthStates.stateHash, sha256(state)));
  if (!row || row.createdBy !== ctx.userId || row.provider !== "shopify") throw notFound();
  const shop = provider.normalizeShop(q.get("shop") ?? "");
  if (row.usedAt) throw badRequest("state already used");
  if (row.expiresAt.getTime() < Date.now()) throw badRequest("state expired");
  if (row.shop !== shop) throw badRequest("shop does not match the install request");
  const [claimed] = await t.tx
    .update(oauthStates)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthStates.id, row.id), isNull(oauthStates.usedAt)))
    .returning({ id: oauthStates.id });
  if (!claimed) throw badRequest("state already used");

  const brand = await ownBrand(t, state.split(".")[0] ?? "");
  if (!brand) throw notFound();

  const refused = () =>
    json(
      { error: "This store is connected to another account. Our team has been notified." },
      { status: 409 },
    );
  const owner = await shopOwner("shopify", shop);
  if (owner && owner.orgId !== t.orgId) {
    await flagIntegrationConflict({
      requestingOrgId: t.orgId,
      userId: ctx.userId,
      shop,
      existing: owner,
    });
    return refused();
  }

  const auth = await provider.completeAuthorization(q);
  if (!auth || auth.shop !== shop) return json({ error: "authorization failed" }, { status: 400 });
  const conn = { shop, accessToken: auth.accessToken };
  const shopInfo = await provider.fetchShopInfo(conn);
  const secret = encryptSecret(auth.accessToken);
  const values = {
    status: "connected" as const,
    domain: shop,
    scopes: auth.scopes,
    credentialsCiphertext: secret.ciphertext,
    credentialsKeyId: secret.keyId,
    installedAt: new Date(),
  };

  let integration = owner ? await t.find(integrations, owner.id) : null;
  const reconnect = !!integration;
  const before = integration ? integrationView(integration) : null;
  if (integration) {
    integration = await t.update(integrations, integration.id, {
      ...values,
      brandId: integration.brandId ?? brand.id,
    });
  } else {
    const [inserted] = await t.tx
      .insert(integrations)
      .values({
        ...values,
        orgId: t.orgId,
        provider: "shopify",
        externalShopId: shop,
        brandId: brand.id,
      })
      .onConflictDoNothing({ target: [integrations.provider, integrations.externalShopId] })
      .returning();
    integration = inserted ?? null;
    if (!integration) {
      const raced = await shopOwner("shopify", shop);
      if (raced && raced.orgId !== t.orgId)
        await flagIntegrationConflict({
          requestingOrgId: t.orgId,
          userId: ctx.userId,
          shop,
          existing: raced,
        });
      return refused();
    }
  }
  const i = integration!;

  const [store] = await t.list(
    stores,
    and(eq(stores.integrationId, i.id), eq(stores.brandId, brand.id)),
  );
  if (store) await t.update(stores, store.id, { domain: shop, currency: shopInfo.currency });
  else
    await t.insert(stores, {
      integrationId: i.id,
      brandId: brand.id,
      domain: shop,
      currency: shopInfo.currency,
    });

  let webhooks: "subscribed" | "failed" = "subscribed";
  try {
    await provider.subscribeWebhooks(conn, `${siteUrl(req)}${webhookPath}`);
  } catch {
    webhooks = "failed";
  }

  await enqueue(t, { kind: JOB_RECONCILE, payload: { integrationId: i.id } });
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: reconnect ? "integration.reconnected" : "integration.connected",
      entityType: "integration",
      entityId: i.id,
      before,
      after: { ...integrationView(i), brandIdForStore: brand.id, webhooks },
    },
    t.tx,
  );
  return new Response(null, {
    status: 303,
    headers: {
      location: `${siteUrl(req)}/dashboard?integration=${reconnect ? "reconnected" : "connected"}`,
    },
  });
}
