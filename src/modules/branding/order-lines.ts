import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { TenantDb } from "@/db/tenant";
import { brandProducts, brandProductVariants, labels, skus } from "@/db/schema";

export type BrandVariantMatch = {
  variantId: string;
  brandProductId: string;
  skuId: string;
  sku: string;
  currency: string;
};

const variantFields = {
  variantId: brandProductVariants.id,
  brandProductId: brandProductVariants.brandProductId,
  skuId: brandProductVariants.skuId,
  sku: skus.sku,
  currency: brandProductVariants.currency,
};

function activeVariantsOf(t: TenantDb, brandId: string, filter: SQL): Promise<BrandVariantMatch[]> {
  return t.tx
    .select(variantFields)
    .from(brandProductVariants)
    .innerJoin(brandProducts, eq(brandProducts.id, brandProductVariants.brandProductId))
    .innerJoin(skus, eq(skus.id, brandProductVariants.skuId))
    .where(
      and(
        eq(brandProductVariants.orgId, t.orgId),
        eq(brandProducts.brandId, brandId),
        eq(brandProductVariants.isActive, true),
        filter,
      ),
    );
}

/** Active variants of `brandId` among `variantIds` (e.g. from a store's sync mapping). */
export async function brandVariantsById(t: TenantDb, brandId: string, variantIds: string[]) {
  if (variantIds.length === 0) return [];
  return activeVariantsOf(t, brandId, inArray(brandProductVariants.id, variantIds));
}

/** Active variants of `brandId` whose catalog SKU code is in `codes`. */
export async function brandVariantsBySku(t: TenantDb, brandId: string, codes: string[]) {
  if (codes.length === 0) return [];
  return activeVariantsOf(t, brandId, inArray(skus.sku, codes));
}

/** Latest `approved` label (highest version) per brand product; products without one are absent. */
export async function latestApprovedLabels(
  t: TenantDb,
  brandProductIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (brandProductIds.length === 0) return out;
  const rows = await t.tx
    .select({ id: labels.id, brandProductId: labels.brandProductId })
    .from(labels)
    .where(
      and(
        eq(labels.orgId, t.orgId),
        eq(labels.status, "approved"),
        inArray(labels.brandProductId, brandProductIds),
      ),
    )
    .orderBy(desc(labels.version));
  for (const r of rows) if (!out.has(r.brandProductId)) out.set(r.brandProductId, r.id);
  return out;
}
