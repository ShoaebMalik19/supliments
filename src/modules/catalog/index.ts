import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { TenantDb } from "@/db/tenant";
import { catalogProducts, skuCosts, skus } from "@/db/schema";
import type { Money } from "@/lib/money";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const productFields = {
  id: catalogProducts.id,
  name: catalogProducts.name,
  categoryId: catalogProducts.categoryId,
  description: catalogProducts.description,
  ingredients: catalogProducts.ingredients,
  spec: catalogProducts.spec,
  mode: catalogProducts.mode,
  labelTemplateId: catalogProducts.labelTemplateId,
  defaultMsrpMinor: catalogProducts.defaultMsrpMinor,
  currency: catalogProducts.currency,
  restrictedCountries: catalogProducts.restrictedCountries,
};

const skuFields = {
  id: skus.id,
  sku: skus.sku,
  attributes: skus.attributes,
  weightGrams: skus.weightGrams,
  dimensionsMm: skus.dimensionsMm,
  baseCostMinor: skus.baseCostMinor,
  currency: skus.currency,
  moq: skus.moq,
  leadTimeDays: skus.leadTimeDays,
};

/** Tenant-facing browse: only `active` products are visible; reads run under RLS (catalog_read). */
export async function listActiveProducts(t: TenantDb) {
  return t.tx
    .select(productFields)
    .from(catalogProducts)
    .where(eq(catalogProducts.status, "active"))
    .orderBy(asc(catalogProducts.name));
}

export async function getActiveProduct(t: TenantDb, id: string) {
  if (!UUID_RE.test(id)) return null;
  const [product] = await t.tx
    .select(productFields)
    .from(catalogProducts)
    .where(and(eq(catalogProducts.id, id), eq(catalogProducts.status, "active")));
  if (!product) return null;
  const variants = await t.tx
    .select(skuFields)
    .from(skus)
    .where(and(eq(skus.catalogProductId, id), eq(skus.isActive, true)))
    .orderBy(asc(skus.sku));
  return { ...product, skus: variants };
}

/** Catalog SKUs among `codes` (any status): distinguishes "ours" from a brand's other goods. */
export async function skusByCode(t: TenantDb, codes: string[]) {
  if (codes.length === 0) return [];
  return t.tx.select({ id: skus.id, sku: skus.sku }).from(skus).where(inArray(skus.sku, codes));
}

/**
 * Our unit cost for each SKU at `at`: the sku_costs row for the SKU's default fulfillment centre
 * whose [effective_from, effective_to) contains `at` (latest start wins), else base_cost_minor.
 */
export async function skuUnitCostsAt(
  t: TenantDb,
  skuIds: string[],
  at: Date,
): Promise<Map<string, Money>> {
  const out = new Map<string, Money>();
  if (skuIds.length === 0) return out;
  const atSql = sql`${at.toISOString()}::timestamptz`;
  const rows = await t.tx
    .select({
      skuId: skus.id,
      baseCostMinor: skus.baseCostMinor,
      baseCurrency: skus.currency,
      costMinor: skuCosts.costMinor,
      costCurrency: skuCosts.currency,
    })
    .from(skus)
    .leftJoin(
      skuCosts,
      and(
        eq(skuCosts.skuId, skus.id),
        eq(skuCosts.fulfillmentCenterId, skus.defaultFulfillmentCenterId),
        lte(skuCosts.effectiveFrom, atSql),
        or(isNull(skuCosts.effectiveTo), gt(skuCosts.effectiveTo, atSql)),
      ),
    )
    .where(inArray(skus.id, skuIds))
    .orderBy(skus.id, desc(skuCosts.effectiveFrom));
  for (const r of rows) {
    if (out.has(r.skuId)) continue;
    out.set(
      r.skuId,
      r.costMinor !== null && r.costCurrency !== null
        ? { amountMinor: r.costMinor, currency: r.costCurrency }
        : { amountMinor: r.baseCostMinor, currency: r.baseCurrency },
    );
  }
  return out;
}
