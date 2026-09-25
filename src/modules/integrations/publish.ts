import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { withTenant, type TenantDb } from "@/db/tenant";
import { integrations, productSyncMappings, stores } from "@/db/schema";
import { readAssetBytes } from "@/modules/assets";
import { recordAudit } from "@/modules/audit";
import { markBrandProductPublished, publishableProduct } from "@/modules/branding";
import { enqueue } from "@/modules/jobs";
import type { TenantContext } from "@/modules/tenancy";
import { badRequest, HttpError, json, notFound } from "@/lib/http";
import { commerce, IntegrationUnavailableError, withStore } from "./connection";
import { JOB_PUBLISH_PRODUCT } from "./privileged";
import type { PublishProductInput } from "./provider";

const PUBLISHABLE = ["approved", "published"];

const publishBody = z.strictObject({ integrationId: z.uuid().optional() });

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Queues a push of an approved brand product to a connected store of the same org. Without
 * `integrationId`, the store connected for the product's brand is used.
 */
export async function requestPublish(
  ctx: TenantContext,
  t: TenantDb,
  brandProductId: string,
  raw: unknown,
) {
  const product = await publishableProduct(t, brandProductId);
  if (!product) return null;
  const body = publishBody.safeParse(raw ?? {});
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join("; "));
  if (!PUBLISHABLE.includes(product.status))
    throw new HttpError(409, "Only approved brand products can be published");

  const brandStores = await t.list(stores, eq(stores.brandId, product.brandId));
  const integrationId = body.data.integrationId ?? brandStores[0]?.integrationId;
  if (!integrationId) throw new HttpError(409, "No store connected for this brand");
  const integration = await t.find(integrations, integrationId);
  if (!integration) throw notFound();
  if (integration.status !== "connected")
    throw new HttpError(409, `Store integration is ${integration.status}`);
  const store =
    brandStores.find((s) => s.integrationId === integration.id) ??
    (await t.list(stores, eq(stores.integrationId, integration.id)))[0];
  if (!product.variants.length) throw new HttpError(409, "No active variants to publish");
  if (store && product.variants.some((v) => v.currency !== store.currency))
    throw new HttpError(409, `Store currency is ${store.currency}; product prices must match`);

  await enqueue(t, {
    kind: JOB_PUBLISH_PRODUCT,
    payload: { brandProductId: product.id, integrationId: integration.id },
  });
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "brand_product.publish_requested",
      entityType: "brand_product",
      entityId: product.id,
      after: { integrationId: integration.id },
    },
    t.tx,
  );
  return json(
    { status: "queued", brandProductId: product.id, integrationId: integration.id },
    { status: 202 },
  );
}

const variantTitle = (v: { sku: string; attributes: unknown }) => {
  const attrs = v.attributes && typeof v.attributes === "object" ? Object.values(v.attributes) : [];
  const parts = attrs.filter((x) => typeof x === "string" || typeof x === "number").map(String);
  return parts.length ? parts.join(" / ") : v.sku;
};

/** Canonical publish payload hash: identical input → identical hash → the push is skipped. */
export function publishHash(input: PublishProductInput) {
  const canonical = JSON.stringify({
    title: input.title,
    description: input.descriptionHtml,
    variants: input.variants.map((v) => [v.sku, v.priceMinor.toString(), v.currency, v.title]),
    images: input.images.map((i) => createHash("sha256").update(i.data).digest("hex")),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function runPublishJob(
  orgId: string,
  payload: { brandProductId: string; integrationId: string },
) {
  const prep = await withTenant(orgId, async (t) => {
    const integration = await t.find(integrations, payload.integrationId);
    const product = await publishableProduct(t, payload.brandProductId);
    if (!integration || integration.status !== "connected" || !product) return null;
    if (!PUBLISHABLE.includes(product.status) || !product.variants.length) return null;
    const mappings = await t.list(
      productSyncMappings,
      and(
        eq(productSyncMappings.integrationId, integration.id),
        inArray(
          productSyncMappings.brandProductVariantId,
          product.variants.map((v) => v.id),
        ),
      ),
    );
    const images: PublishProductInput["images"] = [];
    for (const id of product.mockupAssetIds) {
      const got = await readAssetBytes(t, id);
      if (got)
        images.push({
          data: got.data,
          mime: got.asset.mime,
          filename: `${id}.${EXT[got.asset.mime] ?? "bin"}`,
        });
    }
    return { product, mappings, images };
  });
  if (!prep) return { outcome: "skipped" as const, reason: "not publishable" };
  const { product, mappings, images } = prep;

  const byVariant = new Map(mappings.map((m) => [m.brandProductVariantId, m]));
  const input: PublishProductInput = {
    title: product.title,
    descriptionHtml: product.description ? `<p>${escapeHtml(product.description)}</p>` : null,
    externalProductId: mappings.find((m) => m.externalProductId)?.externalProductId ?? null,
    variants: product.variants.map((v) => ({
      sku: v.sku,
      priceMinor: v.retailPriceMinor,
      currency: v.currency,
      title: variantTitle(v),
      externalVariantId: byVariant.get(v.id)?.externalVariantId ?? null,
    })),
    images,
  };
  const hash = publishHash(input);
  const unchanged =
    input.externalProductId !== null &&
    product.variants.every((v) => {
      const m = byVariant.get(v.id);
      return m?.lastPushHash === hash && m.syncStatus === "synced";
    });
  if (unchanged) return { outcome: "unchanged" as const };

  let published;
  try {
    published = await withStore(orgId, payload.integrationId, (conn) =>
      commerce().pushProduct(conn, input),
    );
  } catch (e) {
    if (e instanceof IntegrationUnavailableError)
      return { outcome: "skipped" as const, reason: e.reason };
    throw e;
  }

  await withTenant(orgId, async (t) => {
    const now = new Date();
    for (const v of product.variants) {
      const pv = published.variants.find((x) => x.sku === v.sku)!;
      const values = {
        externalProductId: published.externalProductId,
        externalVariantId: pv.externalVariantId,
        externalInventoryItemId: pv.externalInventoryItemId,
        lastPushedAt: now,
        lastPushHash: hash,
        syncStatus: "synced" as const,
        error: null,
      };
      const existing = byVariant.get(v.id);
      if (existing) await t.update(productSyncMappings, existing.id, values);
      else
        await t.insert(productSyncMappings, {
          ...values,
          brandProductVariantId: v.id,
          integrationId: payload.integrationId,
        });
    }
    await markBrandProductPublished(t, product.id);
    await recordAudit(
      {
        orgId,
        actorUserId: null,
        actorType: "system",
        action: "brand_product.published",
        entityType: "brand_product",
        entityId: product.id,
        after: {
          integrationId: payload.integrationId,
          externalProductId: published.externalProductId,
          variants: published.variants.length,
          images: images.length,
        },
      },
      t.tx,
    );
  });
  return { outcome: "published" as const, externalProductId: published.externalProductId };
}
