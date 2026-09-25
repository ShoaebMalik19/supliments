import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { privilegedDb } from "../../src/db/privileged";
import {
  catalogProducts,
  categories,
  feeSchedules,
  fulfillmentCenters,
  labelTemplates,
  manufacturers,
  partnerSkuMappings,
  skus,
} from "../../src/db/schema";
import { createLabelTemplate } from "../../src/modules/labels/admin";

export const DEMO_FEE_RULES = {
  perOrderFulfillmentFeeMinor: 250,
  perUnitFulfillmentFeeMinor: 75,
  shipping: { firstUnitMinor: 499, additionalUnitMinor: 99 },
  platformMarkupBps: 1500,
};

export const DEMO_SKUS = [
  { sku: "DEMO-CRE-60-UNF", flavor: "Unflavored", costMinor: 850n, partnerCode: "MFR-CRE60-U" },
  { sku: "DEMO-CRE-60-BRY", flavor: "Berry", costMinor: 975n, partnerCode: "MFR-CRE60-B" },
];

const PLACEHOLDER = join(
  import.meta.dirname,
  "../../db/seed/label-templates/placeholder-60ct-bottle.json",
);

/**
 * Platform data an admin would normally manage: fee schedule, manufacturer + fulfillment center,
 * the placeholder label template (loaded from its JSON data file), one on_demand catalog product
 * with two SKUs and partner SKU codes. Idempotent.
 */
export async function seedPlatform() {
  const db = privilegedDb();
  const now = new Date();

  const [inForce] = await db
    .select()
    .from(feeSchedules)
    .where(
      and(
        lte(feeSchedules.effectiveFrom, now),
        or(isNull(feeSchedules.effectiveTo), gt(feeSchedules.effectiveTo, now)),
      ),
    )
    .orderBy(desc(feeSchedules.version))
    .limit(1);
  let feeSchedule = inForce;
  if (!feeSchedule) {
    const [latest] = await db
      .select()
      .from(feeSchedules)
      .orderBy(desc(feeSchedules.version))
      .limit(1);
    [feeSchedule] = await db
      .insert(feeSchedules)
      .values({
        version: (latest?.version ?? 0) + 1,
        currency: "USD",
        rules: DEMO_FEE_RULES,
        effectiveFrom: new Date("2026-01-01"),
      })
      .returning();
  }

  const mfrName = "Demo Manufacturing Co. (no API — spreadsheet)";
  let [mfr] = await db.select().from(manufacturers).where(eq(manufacturers.name, mfrName));
  mfr ??= (
    await db
      .insert(manufacturers)
      .values({ name: mfrName, adapterKey: "manual", leadTimeDays: 5 })
      .returning()
  )[0];

  const fcName = "Demo Fulfillment Center (Reno, NV)";
  let [fc] = await db.select().from(fulfillmentCenters).where(eq(fulfillmentCenters.name, fcName));
  fc ??= (
    await db
      .insert(fulfillmentCenters)
      .values({
        name: fcName,
        manufacturerId: mfr!.id,
        address: { address1: "1 Industrial Way", city: "Reno", province: "NV", zip: "89501" },
        country: "US",
        regionsServed: ["US"],
        adapterKey: "manual",
      })
      .returning()
  )[0];

  const templateJson = JSON.parse(readFileSync(PLACEHOLDER, "utf8")) as { name: string };
  let [template] = await db
    .select()
    .from(labelTemplates)
    .where(eq(labelTemplates.name, templateJson.name));
  template ??= await createLabelTemplate(null, templateJson);

  let [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.slug, "sports-nutrition"));
  category ??= (
    await db
      .insert(categories)
      .values({ name: "Sports nutrition", slug: "sports-nutrition" })
      .returning()
  )[0];

  const productName = "Creatine Monohydrate — 60 capsules";
  let [product] = await db
    .select()
    .from(catalogProducts)
    .where(eq(catalogProducts.name, productName));
  product ??= (
    await db
      .insert(catalogProducts)
      .values({
        name: productName,
        categoryId: category!.id,
        description: "Micronized creatine monohydrate, 750 mg per capsule.",
        mode: "on_demand",
        labelTemplateId: template!.id,
        defaultMsrpMinor: 2999n,
        currency: "USD",
        status: "active",
      })
      .returning()
  )[0];

  const skuRows = [];
  for (const s of DEMO_SKUS) {
    let [row] = await db.select().from(skus).where(eq(skus.sku, s.sku));
    row ??= (
      await db
        .insert(skus)
        .values({
          catalogProductId: product!.id,
          sku: s.sku,
          attributes: { count: 60, flavor: s.flavor },
          weightGrams: 90,
          baseCostMinor: s.costMinor,
          currency: "USD",
          defaultFulfillmentCenterId: fc!.id,
        })
        .returning()
    )[0];
    await db
      .insert(partnerSkuMappings)
      .values({ skuId: row!.id, manufacturerId: mfr!.id, partnerSkuCode: s.partnerCode })
      .onConflictDoNothing();
    skuRows.push(row!);
  }

  return {
    feeSchedule: feeSchedule!,
    manufacturer: mfr!,
    fulfillmentCenter: fc!,
    template: template!,
    product: product!,
    skus: skuRows,
  };
}
