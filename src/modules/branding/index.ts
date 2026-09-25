import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { TenantDb } from "@/db/tenant";
import { brandProducts, brandProductVariants, brands, skus } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { getActiveProduct } from "@/modules/catalog";
import { feeScheduleAt, unitEconomics, type ActiveFeeSchedule } from "@/modules/pricing";
import type { TenantContext } from "@/modules/tenancy";
import { badRequest, HttpError, notFound } from "@/lib/http";
import { currencyInput, nonNegativeMinorInput } from "@/lib/money";

const uuid = z.uuid();

const parse = <T extends z.ZodType>(schema: T, raw: unknown): z.output<T> => {
  const r = schema.safeParse(raw);
  if (!r.success)
    throw badRequest(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
};

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "brand";

export async function listBrands(t: TenantDb) {
  return t.tx.select().from(brands).where(eq(brands.orgId, t.orgId)).orderBy(asc(brands.createdAt));
}

const brandInput = z.strictObject({
  name: z.string().trim().min(2).max(100),
  supportEmail: z.email().optional(),
});

export async function createBrand(ctx: TenantContext, t: TenantDb, raw: unknown) {
  const input = parse(brandInput, raw);
  const base = slugify(input.name);
  const taken = await t.list(brands, eq(brands.slug, base));
  const slug = taken.length ? `${base}-${randomBytes(3).toString("hex")}` : base;
  const brand = await t.insert(brands, {
    name: input.name,
    slug,
    supportEmail: input.supportEmail,
  });
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "brand.created",
      entityType: "brand",
      entityId: brand.id,
      after: { name: brand.name, slug },
    },
    t.tx,
  );
  return brand;
}

const variantPrice = z.strictObject({ skuId: uuid, retailPriceMinor: nonNegativeMinorInput });

const brandProductInput = z.strictObject({
  brandId: uuid,
  catalogProductId: uuid,
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  currency: currencyInput,
  variants: z.array(variantPrice).min(1),
});

type Margin = ReturnType<typeof unitEconomics> & { feeScheduleVersion: number };

function marginFor(
  schedule: ActiveFeeSchedule | null,
  retailPriceMinor: bigint,
  currency: string,
  sku: { baseCostMinor: bigint; currency: string },
): Margin | null {
  if (!schedule || schedule.currency !== currency || sku.currency !== currency) return null;
  return {
    ...unitEconomics({ retailPriceMinor, unitCostMinor: sku.baseCostMinor, rules: schedule.rules }),
    feeScheduleVersion: schedule.version,
  };
}

export async function createBrandProduct(ctx: TenantContext, t: TenantDb, raw: unknown) {
  const input = parse(brandProductInput, raw);
  const brand = await t.find(brands, input.brandId);
  if (!brand) throw notFound();
  const product = await getActiveProduct(t, input.catalogProductId);
  if (!product) throw notFound();
  if (product.currency !== input.currency)
    throw badRequest(`currency must be ${product.currency} for this product`);
  const skuIds = input.variants.map((v) => v.skuId);
  if (new Set(skuIds).size !== skuIds.length) throw badRequest("duplicate skuId");
  const offered = new Map(product.skus.map((s) => [s.id, s]));
  if (skuIds.some((id) => !offered.has(id))) throw badRequest("skuId does not belong to product");

  const minPrice = input.variants.reduce(
    (m, v) => (v.retailPriceMinor < m ? v.retailPriceMinor : m),
    input.variants[0]!.retailPriceMinor,
  );
  const bp = await t.insert(brandProducts, {
    brandId: brand.id,
    catalogProductId: product.id,
    title: input.title ?? `${brand.name} ${product.name}`,
    description: input.description ?? product.description,
    retailPriceMinor: minPrice,
    currency: input.currency,
  });
  for (const v of input.variants) {
    await t.insert(brandProductVariants, {
      brandProductId: bp.id,
      skuId: v.skuId,
      retailPriceMinor: v.retailPriceMinor,
      currency: input.currency,
    });
  }
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "brand_product.created",
      entityType: "brand_product",
      entityId: bp.id,
      after: { brandId: brand.id, catalogProductId: product.id, variants: input.variants },
    },
    t.tx,
  );
  return (await getBrandProduct(t, bp.id))!;
}

export async function listBrandProducts(t: TenantDb) {
  return t.list(brandProducts);
}

export async function getBrandProduct(t: TenantDb, id: string) {
  const bp = await t.find(brandProducts, id);
  if (!bp) return null;
  const variants = await t.tx
    .select({
      id: brandProductVariants.id,
      skuId: brandProductVariants.skuId,
      sku: skus.sku,
      attributes: skus.attributes,
      retailPriceMinor: brandProductVariants.retailPriceMinor,
      currency: brandProductVariants.currency,
      isActive: brandProductVariants.isActive,
      baseCostMinor: skus.baseCostMinor,
      skuCurrency: skus.currency,
    })
    .from(brandProductVariants)
    .innerJoin(skus, eq(skus.id, brandProductVariants.skuId))
    .where(
      and(eq(brandProductVariants.brandProductId, id), eq(brandProductVariants.orgId, t.orgId)),
    )
    .orderBy(asc(skus.sku));
  const schedule = await feeScheduleAt(t);
  return {
    ...bp,
    variants: variants.map(({ baseCostMinor, skuCurrency, ...v }) => ({
      ...v,
      margin: marginFor(schedule, v.retailPriceMinor, v.currency, {
        baseCostMinor,
        currency: skuCurrency,
      }),
    })),
  };
}

const pricingPatch = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  variants: z
    .array(z.strictObject({ variantId: uuid, retailPriceMinor: nonNegativeMinorInput }))
    .optional(),
});

export async function updateBrandProduct(
  ctx: TenantContext,
  t: TenantDb,
  id: string,
  raw: unknown,
) {
  const before = await getBrandProduct(t, id);
  if (!before) return null;
  const input = parse(pricingPatch, raw);
  if (input.title !== undefined || input.description !== undefined)
    await t.update(brandProducts, id, { title: input.title, description: input.description });
  if (input.variants?.length) {
    const own = new Set(before.variants.map((v) => v.id));
    if (input.variants.some((v) => !own.has(v.variantId))) throw notFound();
    for (const v of input.variants)
      await t.update(brandProductVariants, v.variantId, { retailPriceMinor: v.retailPriceMinor });
    const prices = await t.tx
      .select({ p: brandProductVariants.retailPriceMinor })
      .from(brandProductVariants)
      .where(inArray(brandProductVariants.id, [...own]));
    const min = prices.reduce((m, r) => (r.p < m ? r.p : m), prices[0]!.p);
    await t.update(brandProducts, id, { retailPriceMinor: min });
  }
  const after = (await getBrandProduct(t, id))!;
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "brand_product.updated",
      entityType: "brand_product",
      entityId: id,
      before: {
        title: before.title,
        variants: before.variants.map((v) => [v.id, v.retailPriceMinor]),
      },
      after: {
        title: after.title,
        variants: after.variants.map((v) => [v.id, v.retailPriceMinor]),
      },
    },
    t.tx,
  );
  return after;
}

const marginQuery = z.strictObject({ skuId: uuid, retailPriceMinor: nonNegativeMinorInput });

/** Margin calculator over platform data: SKU cost + the fee schedule in force now. */
export async function marginQuote(t: TenantDb, raw: unknown) {
  const q = parse(marginQuery, raw);
  const [sku] = await t.tx
    .select({
      id: skus.id,
      baseCostMinor: skus.baseCostMinor,
      currency: skus.currency,
      active: skus.isActive,
    })
    .from(skus)
    .where(eq(skus.id, q.skuId));
  if (!sku || !sku.active) throw notFound();
  const schedule = await feeScheduleAt(t);
  if (!schedule) throw new HttpError(409, "No fee schedule in force");
  const margin = marginFor(schedule, q.retailPriceMinor, sku.currency, sku);
  if (!margin) throw new HttpError(409, "SKU currency differs from fee schedule currency");
  return { skuId: sku.id, currency: sku.currency, ...margin };
}

export type BrandProductStatus = (typeof brandProducts.$inferSelect)["status"];

/** The bare brand product row of the caller's org (no variants/margins), or null. */
export async function findBrandProduct(t: TenantDb, id: string) {
  return t.find(brandProducts, id);
}

/** Review/label state of a brand product; driven by the labels module. */
export async function setBrandProductLabelState(
  t: TenantDb,
  id: string,
  values: { status?: BrandProductStatus; primaryMockupAssetId?: string },
) {
  return t.update(brandProducts, id, values);
}
export * from "./order-lines";
