import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { privilegedDb } from "@/db/privileged";
import { catalogProducts, labels, labelTemplates, reviewQueueItems } from "@/db/schema";
import { loadLabelTemplate } from "@/modules/labels";
import { createAsset, seedBrandProduct, type createTenant } from "./helpers";

type Tenant = Awaited<ReturnType<typeof createTenant>>;
type LabelStatus = (typeof labels.$inferSelect)["status"];

export const PLACEHOLDER_PATH = join(
  import.meta.dirname,
  "../db/seed/label-templates/placeholder-60ct-bottle.json",
);

export const placeholderJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(PLACEHOLDER_PATH, "utf8"));

export const VALID_DESIGN = { brandName: "Acme Labs", variantName: "Berry Blast" };

export async function insertTemplate(json: unknown) {
  const t = loadLabelTemplate(json);
  const [row] = await privilegedDb()
    .insert(labelTemplates)
    .values({
      name: t.name,
      isPlaceholder: t.isPlaceholder,
      printSpec: t.printSpec,
      editableFields: t.editableFields,
      fixedPanels: t.fixedPanels,
      mockupSpec: t.mockupSpec,
    })
    .returning();
  return row!.id;
}

let placeholderId: string | undefined;
export async function placeholderTemplateId() {
  placeholderId ??= await insertTemplate(placeholderJson());
  return placeholderId;
}

/** A brand product whose catalog product points at the placeholder label template. */
export async function seedLabelledBrandProduct(tenant: Tenant) {
  const seeded = await seedBrandProduct(tenant);
  await privilegedDb()
    .update(catalogProducts)
    .set({ labelTemplateId: await placeholderTemplateId() })
    .where(eq(catalogProducts.id, seeded.product.id));
  return seeded;
}

/** Inserts a label row directly (no rendering); `submitted` also opens its review item. */
export async function seedLabel(
  tenant: Tenant,
  opts: { status?: LabelStatus; design?: Record<string, string> } = {},
) {
  const { brandProduct } = await seedLabelledBrandProduct(tenant);
  const status = opts.status ?? "draft";
  const [label] = await privilegedDb()
    .insert(labels)
    .values({
      orgId: tenant.org.id,
      brandId: tenant.brand.id,
      brandProductId: brandProduct.id,
      labelTemplateId: await placeholderTemplateId(),
      version: 1,
      designState: opts.design ?? VALID_DESIGN,
      status,
    })
    .returning();
  if (status === "submitted")
    await privilegedDb().insert(reviewQueueItems).values({
      orgId: tenant.org.id,
      type: "label_review",
      entityType: "label",
      entityId: label!.id,
    });
  return { label: label!, brandProduct };
}

export async function pngBytes(width: number, height: number, color: string) {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 4, background: color } })
      .png()
      .toBuffer(),
  );
}

/** A ready logo asset with real PNG bytes in the fake storage (orgId null = platform asset). */
export async function readyPng(
  orgId: string | null,
  kind: "logo" | "product_image" = "logo",
  color = "#CC2200",
) {
  const content = await pngBytes(40, 20, color);
  return createAsset(orgId, { kind, uploadStatus: "ready", bytes: content.length, content });
}
