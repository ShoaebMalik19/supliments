import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import { privilegedDb } from "@/db/privileged";
import { catalogProducts, categories, skuCosts, skus } from "@/db/schema";
import type { AdminContext } from "@/modules/admin";
import { recordAudit } from "@/modules/audit";
import { badRequest, HttpError } from "@/lib/http";
import { currencyInput, nonNegativeMinorInput } from "@/lib/money";

const uuid = z.uuid();
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
const name = z.string().trim().min(1).max(200);
const countries = z.array(z.string().regex(/^[A-Z]{2}$/)).max(250);
const json = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]);
const nonEmpty = (o: object) => Object.keys(o).length > 0;
const moneyPaired = (amountKey: string) => (o: Record<string, unknown>) =>
  (o[amountKey] === undefined) === (o.currency === undefined);

const categoryCreate = z.strictObject({ name, slug, parentId: uuid.nullish() });
const categoryUpdate = categoryCreate.partial().refine(nonEmpty, "empty update");

const productFields = {
  name,
  categoryId: uuid.nullish(),
  description: z.string().max(10_000).nullish(),
  ingredients: z.array(z.unknown()).optional(),
  spec: json.optional(),
  mode: z.enum(["on_demand", "stocked"]).optional(),
  labelTemplateId: uuid.nullish(),
  defaultMsrpMinor: nonNegativeMinorInput.nullish(),
  currency: currencyInput,
  restrictedCountries: countries.optional(),
  status: z.enum(["draft", "active", "discontinued"]).optional(),
};
const productCreate = z.strictObject(productFields);
const productUpdate = z
  .strictObject(productFields)
  .partial()
  .refine(nonEmpty, "empty update")
  .refine(moneyPaired("defaultMsrpMinor"), "defaultMsrpMinor and currency go together");

const skuFields = {
  sku: z.string().trim().min(1).max(64),
  attributes: z.record(z.string(), z.unknown()).optional(),
  weightGrams: z.int().positive().nullish(),
  dimensionsMm: z.record(z.string(), z.int().positive()).nullish(),
  barcode: z.string().max(64).nullish(),
  hsCode: z.string().max(16).nullish(),
  baseCostMinor: nonNegativeMinorInput,
  currency: currencyInput,
  moq: z.int().positive().optional(),
  leadTimeDays: z.int().nonnegative().nullish(),
  isActive: z.boolean().optional(),
};
const skuCreate = z.strictObject({ catalogProductId: uuid, ...skuFields });
const skuUpdate = z
  .strictObject(skuFields)
  .partial()
  .refine(nonEmpty, "empty update")
  .refine(moneyPaired("baseCostMinor"), "baseCostMinor and currency go together");

const skuCostCreate = z
  .strictObject({
    fulfillmentCenterId: uuid,
    costMinor: nonNegativeMinorInput,
    currency: currencyInput,
    effectiveFrom: z.coerce.date(),
    effectiveTo: z.coerce.date().nullish(),
  })
  .refine((c) => !c.effectiveTo || c.effectiveTo > c.effectiveFrom, "effectiveTo must be later");

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (!r.success)
    throw badRequest(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

function constraintError(e: unknown): unknown {
  const code = (e as { cause?: { code?: string } }).cause?.code;
  if (code === "23505") return new HttpError(409, "Already exists");
  if (code === "23503" || code === "23514") return badRequest("Invalid reference or value");
  return e;
}

/** Runs a catalog write and its admin audit row in one privileged transaction. */
async function audited<R extends { id: string }>(
  admin: AdminContext,
  action: string,
  entityType: string,
  fn: (tx: Tx) => Promise<{ before: unknown; after: R } | null>,
): Promise<R | null> {
  try {
    return await privilegedDb().transaction(async (tx) => {
      const out = await fn(tx);
      if (!out) return null;
      await recordAudit(
        {
          orgId: null,
          actorUserId: admin.userId,
          actorType: "admin",
          action: `admin.catalog.${action}`,
          entityType,
          entityId: out.after.id,
          before: out.before,
          after: out.after,
        },
        tx,
      );
      return out.after;
    });
  } catch (e) {
    throw constraintError(e);
  }
}

const idOrNull = (id: string) => (uuid.safeParse(id).success ? id : null);

export async function listCategories(_admin: AdminContext) {
  return privilegedDb().select().from(categories).orderBy(asc(categories.name));
}

export async function createCategory(admin: AdminContext, raw: unknown) {
  const input = parse(categoryCreate, raw);
  return audited(admin, "category_created", "category", async (tx) => {
    const [after] = await tx.insert(categories).values(input).returning();
    return { before: null, after: after! };
  });
}

export async function updateCategory(admin: AdminContext, id: string, raw: unknown) {
  if (!idOrNull(id)) return null;
  const input = parse(categoryUpdate, raw);
  if (input.parentId === id) throw badRequest("A category cannot be its own parent");
  return audited(admin, "category_updated", "category", async (tx) => {
    const [before] = await tx.select().from(categories).where(eq(categories.id, id)).for("update");
    if (!before) return null;
    const [after] = await tx.update(categories).set(input).where(eq(categories.id, id)).returning();
    return { before, after: after! };
  });
}

export async function listProducts(_admin: AdminContext) {
  return privilegedDb().select().from(catalogProducts).orderBy(desc(catalogProducts.createdAt));
}

export async function getProduct(_admin: AdminContext, id: string) {
  if (!idOrNull(id)) return null;
  const db = privilegedDb();
  const [product] = await db.select().from(catalogProducts).where(eq(catalogProducts.id, id));
  if (!product) return null;
  const variants = await db
    .select()
    .from(skus)
    .where(eq(skus.catalogProductId, id))
    .orderBy(asc(skus.sku));
  return { ...product, skus: variants };
}

export async function createProduct(admin: AdminContext, raw: unknown) {
  const input = parse(productCreate, raw);
  return audited(admin, "product_created", "catalog_product", async (tx) => {
    const [after] = await tx.insert(catalogProducts).values(input).returning();
    return { before: null, after: after! };
  });
}

export async function updateProduct(admin: AdminContext, id: string, raw: unknown) {
  if (!idOrNull(id)) return null;
  const input = parse(productUpdate, raw);
  return audited(admin, "product_updated", "catalog_product", async (tx) => {
    const [before] = await tx
      .select()
      .from(catalogProducts)
      .where(eq(catalogProducts.id, id))
      .for("update");
    if (!before) return null;
    const [after] = await tx
      .update(catalogProducts)
      .set(input)
      .where(eq(catalogProducts.id, id))
      .returning();
    return { before, after: after! };
  });
}

export async function listSkus(_admin: AdminContext, catalogProductId?: string | null) {
  const q = privilegedDb().select().from(skus);
  if (catalogProductId) {
    if (!idOrNull(catalogProductId)) throw badRequest("productId must be a UUID");
    return q.where(eq(skus.catalogProductId, catalogProductId)).orderBy(asc(skus.sku));
  }
  return q.orderBy(asc(skus.sku));
}

export async function createSku(admin: AdminContext, raw: unknown) {
  const input = parse(skuCreate, raw);
  return audited(admin, "sku_created", "sku", async (tx) => {
    const [after] = await tx.insert(skus).values(input).returning();
    return { before: null, after: after! };
  });
}

export async function updateSku(admin: AdminContext, id: string, raw: unknown) {
  if (!idOrNull(id)) return null;
  const input = parse(skuUpdate, raw);
  return audited(admin, "sku_updated", "sku", async (tx) => {
    const [before] = await tx.select().from(skus).where(eq(skus.id, id)).for("update");
    if (!before) return null;
    const [after] = await tx.update(skus).set(input).where(eq(skus.id, id)).returning();
    return { before, after: after! };
  });
}

export async function listSkuCosts(_admin: AdminContext, skuId: string) {
  if (!idOrNull(skuId)) return null;
  const [sku] = await privilegedDb().select({ id: skus.id }).from(skus).where(eq(skus.id, skuId));
  if (!sku) return null;
  return privilegedDb()
    .select()
    .from(skuCosts)
    .where(eq(skuCosts.skuId, skuId))
    .orderBy(desc(skuCosts.effectiveFrom));
}

export async function createSkuCost(admin: AdminContext, skuId: string, raw: unknown) {
  if (!idOrNull(skuId)) return null;
  const input = parse(skuCostCreate, raw);
  return audited(admin, "sku_cost_created", "sku_cost", async (tx) => {
    const [sku] = await tx.select({ id: skus.id }).from(skus).where(eq(skus.id, skuId));
    if (!sku) return null;
    const [after] = await tx
      .insert(skuCosts)
      .values({ ...input, skuId })
      .returning();
    return { before: null, after: after! };
  });
}
