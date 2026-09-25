import { and, asc, eq, inArray } from "drizzle-orm";
import type { TenantDb } from "@/db/tenant";
import { integrations, productSyncMappings, stores } from "@/db/schema";

/** The integration an order arrives through, with the brand it sells for (integration, else store). */
export async function integrationForOrders(t: TenantDb, integrationId: string) {
  const integration = await t.find(integrations, integrationId);
  if (!integration) return null;
  let brandId = integration.brandId;
  if (!brandId) {
    const [store] = await t.tx
      .select({ brandId: stores.brandId })
      .from(stores)
      .where(and(eq(stores.orgId, t.orgId), eq(stores.integrationId, integrationId)))
      .orderBy(asc(stores.createdAt))
      .limit(1);
    brandId = store?.brandId ?? null;
  }
  return { id: integration.id, brandId };
}

/** externalVariantId → brand_product_variant_id for this integration's sync mappings. */
export async function mappedVariants(
  t: TenantDb,
  integrationId: string,
  externalVariantIds: string[],
): Promise<Map<string, string>> {
  if (externalVariantIds.length === 0) return new Map();
  const rows = await t.tx
    .select({
      external: productSyncMappings.externalVariantId,
      variantId: productSyncMappings.brandProductVariantId,
    })
    .from(productSyncMappings)
    .where(
      and(
        eq(productSyncMappings.orgId, t.orgId),
        eq(productSyncMappings.integrationId, integrationId),
        inArray(productSyncMappings.externalVariantId, externalVariantIds),
      ),
    );
  return new Map(rows.map((r) => [r.external, r.variantId]));
}
