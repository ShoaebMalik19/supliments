import { and, asc, desc, eq } from "drizzle-orm";
import type { TenantDb } from "@/db/tenant";
import { brandProducts, brandProductVariants, labels, skus } from "@/db/schema";

/**
 * What a store listing is built from: the brand product, its active variants with SKU codes,
 * and the mockups of its latest approved label (falling back to the primary mockup).
 */
export async function publishableProduct(t: TenantDb, id: string) {
  const bp = await t.find(brandProducts, id);
  if (!bp) return null;
  const variants = await t.tx
    .select({
      id: brandProductVariants.id,
      sku: skus.sku,
      attributes: skus.attributes,
      retailPriceMinor: brandProductVariants.retailPriceMinor,
      currency: brandProductVariants.currency,
    })
    .from(brandProductVariants)
    .innerJoin(skus, eq(skus.id, brandProductVariants.skuId))
    .where(
      and(
        eq(brandProductVariants.brandProductId, id),
        eq(brandProductVariants.orgId, t.orgId),
        eq(brandProductVariants.isActive, true),
      ),
    )
    .orderBy(asc(skus.sku));
  const [label] = await t.tx
    .select({ mockupAssetIds: labels.mockupAssetIds })
    .from(labels)
    .where(
      and(eq(labels.brandProductId, id), eq(labels.orgId, t.orgId), eq(labels.status, "approved")),
    )
    .orderBy(desc(labels.version))
    .limit(1);
  const mockupAssetIds = label?.mockupAssetIds.length
    ? label.mockupAssetIds
    : bp.primaryMockupAssetId
      ? [bp.primaryMockupAssetId]
      : [];
  return {
    id: bp.id,
    brandId: bp.brandId,
    title: bp.title,
    description: bp.description,
    status: bp.status,
    currency: bp.currency,
    variants,
    mockupAssetIds,
  };
}

export async function markBrandProductPublished(t: TenantDb, id: string) {
  return t.update(brandProducts, id, { status: "published" });
}
