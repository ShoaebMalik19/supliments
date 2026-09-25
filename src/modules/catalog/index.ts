import { and, asc, eq } from "drizzle-orm";
import type { TenantDb } from "@/db/tenant";
import { catalogProducts, skus } from "@/db/schema";

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
