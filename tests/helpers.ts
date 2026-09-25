import { randomUUID } from "node:crypto";
import { privilegedDb } from "@/db/privileged";
import { eq } from "drizzle-orm";
import {
  assets,
  brandProducts,
  brandProductVariants,
  brands,
  catalogProducts,
  feeSchedules,
  memberships,
  organizations,
  skus,
  users,
} from "@/db/schema";
import { assetsBucket, storageKeyFor } from "@/modules/assets";
import { fakeStorage } from "./fake-storage";

export async function createUser(email = `${randomUUID()}@test.local`) {
  const [user] = await privilegedDb().insert(users).values({ id: randomUUID(), email }).returning();
  return user!;
}

export async function createTenant(name = "Org") {
  const db = privilegedDb();
  const owner = await createUser();
  const [org] = await db.insert(organizations).values({ name }).returning();
  await db.insert(memberships).values({ orgId: org!.id, userId: owner.id, role: "owner" });
  const [brand] = await db
    .insert(brands)
    .values({ orgId: org!.id, name: `${name} Brand`, slug: `brand-${randomUUID()}` })
    .returning();
  return { org: org!, owner, brand: brand! };
}

export async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { cause?: { message?: string }; message: string };
    return err.cause?.message ?? err.message;
  }
  throw new Error("expected query to fail");
}

export async function createAsset(
  orgId: string | null,
  over: Partial<typeof assets.$inferInsert> & { content?: Uint8Array } = {},
) {
  const { content, ...values } = over;
  const id = randomUUID();
  const bucket = assetsBucket();
  const storageKey = orgId ? storageKeyFor(orgId, id) : `platform/${id}`;
  const [asset] = await privilegedDb()
    .insert(assets)
    .values({
      id,
      orgId,
      kind: "logo",
      mime: "image/png",
      bytes: 64,
      bucket,
      storageKey,
      ...values,
    })
    .returning();
  if (content) fakeStorage.put(bucket, storageKey, content);
  return asset!;
}

export const TEST_FEE_RULES = {
  perOrderFulfillmentFeeMinor: 250,
  perUnitFulfillmentFeeMinor: 75,
  shipping: { firstUnitMinor: 499, additionalUnitMinor: 99 },
  platformMarkupBps: 1500,
};

/** Version 1 fee schedule, effective since 2020; shared by all tests. */
export async function ensureFeeSchedule() {
  await privilegedDb()
    .insert(feeSchedules)
    .values({
      version: 1,
      currency: "USD",
      rules: TEST_FEE_RULES,
      effectiveFrom: new Date("2020-01-01"),
    })
    .onConflictDoNothing({ target: feeSchedules.version });
  const [row] = await privilegedDb().select().from(feeSchedules).where(eq(feeSchedules.version, 1));
  return row!;
}

export async function seedCatalogProduct(
  opts: { costs?: bigint[]; status?: "active" | "draft" } = {},
) {
  const db = privilegedDb();
  const [product] = await db
    .insert(catalogProducts)
    .values({
      name: `Creatine ${randomUUID().slice(0, 6)}`,
      currency: "USD",
      status: opts.status ?? "active",
      defaultMsrpMinor: 2999n,
    })
    .returning();
  const skuRows = [];
  for (const [i, cost] of (opts.costs ?? [850n, 1400n]).entries()) {
    const [s] = await db
      .insert(skus)
      .values({
        catalogProductId: product!.id,
        sku: `SKU-${randomUUID().slice(0, 8)}-${i}`,
        baseCostMinor: cost,
        currency: "USD",
      })
      .returning();
    skuRows.push(s!);
  }
  return { product: product!, skus: skuRows };
}

export async function seedBrandProduct(tenant: { org: { id: string }; brand: { id: string } }) {
  const { product, skus: s } = await seedCatalogProduct();
  const [bp] = await privilegedDb()
    .insert(brandProducts)
    .values({
      orgId: tenant.org.id,
      brandId: tenant.brand.id,
      catalogProductId: product.id,
      title: "BP",
      retailPriceMinor: 2999n,
      currency: "USD",
    })
    .returning();
  const variants = [];
  for (const sku of s) {
    const [v] = await privilegedDb()
      .insert(brandProductVariants)
      .values({
        orgId: tenant.org.id,
        brandProductId: bp!.id,
        skuId: sku.id,
        retailPriceMinor: 2999n,
        currency: "USD",
      })
      .returning();
    variants.push(v!);
  }
  return { product, skus: s, brandProduct: bp!, variants };
}
