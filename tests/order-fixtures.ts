import { randomUUID } from "node:crypto";
import { privilegedDb } from "@/db/privileged";
import { integrations, labels, labelTemplates, productSyncMappings } from "@/db/schema";
import { ingestExternalOrder, type ExternalOrder } from "@/modules/orders";
import { createTenant, ensureFeeSchedule, seedBrandProduct } from "./helpers";

type Tenant = Awaited<ReturnType<typeof createTenant>>;

export async function approveLabel(tenant: Tenant, brandProductId: string, version = 1) {
  const [tpl] = await privilegedDb()
    .insert(labelTemplates)
    .values({ name: "T", printSpec: {} })
    .returning();
  const [label] = await privilegedDb()
    .insert(labels)
    .values({
      orgId: tenant.org.id,
      brandId: tenant.brand.id,
      brandProductId,
      labelTemplateId: tpl!.id,
      version,
      status: "approved",
    })
    .returning();
  return label!;
}

export async function createIntegration(tenant: Tenant) {
  const [row] = await privilegedDb()
    .insert(integrations)
    .values({
      orgId: tenant.org.id,
      brandId: tenant.brand.id,
      provider: "shopify",
      externalShopId: `shop-${randomUUID()}`,
    })
    .returning();
  return row!;
}

export async function mapVariant(
  tenant: Tenant,
  integrationId: string,
  brandProductVariantId: string,
  externalVariantId: string,
) {
  await privilegedDb().insert(productSyncMappings).values({
    orgId: tenant.org.id,
    integrationId,
    brandProductVariantId,
    externalVariantId,
  });
}

/** A brand with one approved-label product (2 SKUs, costs 850/1400 USD) and a store integration. */
export async function orderReadyTenant(name = "Orders") {
  await ensureFeeSchedule();
  const tenant = await createTenant(name);
  const bp = await seedBrandProduct(tenant);
  const label = await approveLabel(tenant, bp.brandProduct.id);
  const integration = await createIntegration(tenant);
  return { ...tenant, ...bp, label, integration };
}

export type OrderTenant = Awaited<ReturnType<typeof orderReadyTenant>>;

type Line = ExternalOrder["lines"][number];

export function line(over: Partial<Line> & { sku: string | null }): Line {
  return {
    externalLineItemId: randomUUID(),
    externalVariantId: null,
    title: null,
    quantity: 1,
    unitPriceMinor: 2999n,
    ...over,
  };
}

export function externalOrder(lines: Line[], over: Partial<ExternalOrder> = {}): ExternalOrder {
  const subtotal = lines.reduce((s, l) => s + l.unitPriceMinor * BigInt(l.quantity), 0n);
  return {
    externalOrderId: randomUUID(),
    externalOrderNumber: "#1001",
    currency: "USD",
    placedAt: new Date("2026-06-01T12:00:00Z"),
    financialStatus: "paid",
    cancelled: false,
    test: false,
    customer: { externalId: "c1", email: "c@example.com", name: "C", phone: null },
    shipTo: { name: "C", address1: "1 Main", city: "X", zip: "1", countryCode: "US" },
    billTo: null,
    subtotalMinor: subtotal,
    shippingMinor: 0n,
    totalMinor: subtotal,
    lines,
    ...over,
  };
}

/** 2 × SKU0 + 1 × SKU1 of the tenant's brand product, ingested through its integration. */
export async function ingestStandardOrder(t: OrderTenant, over: Partial<ExternalOrder> = {}) {
  const order = externalOrder(
    [line({ sku: t.skus[0]!.sku, quantity: 2 }), line({ sku: t.skus[1]!.sku })],
    over,
  );
  const res = await ingestExternalOrder(
    { orgId: t.org.id, integrationId: t.integration.id },
    order,
  );
  return { order, res };
}
