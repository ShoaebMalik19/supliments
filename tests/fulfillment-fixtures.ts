import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { fulfillmentCenters, labels, manufacturers, partnerSkuMappings, skus } from "@/db/schema";
import { createDispatchBatch, submitPaidOrder } from "@/modules/fulfillment";
import { recordOrderPayment } from "@/modules/orders";
import { createAsset, createUser } from "./helpers";
import { ingestStandardOrder, orderReadyTenant } from "./order-fixtures";

export async function seedCenter(opts: { active?: boolean } = {}) {
  const db = privilegedDb();
  const [m] = await db
    .insert(manufacturers)
    .values({ name: `Mfr ${randomUUID().slice(0, 6)}` })
    .returning();
  const [fc] = await db
    .insert(fulfillmentCenters)
    .values({
      name: `FC ${randomUUID().slice(0, 6)}`,
      manufacturerId: m!.id,
      address: { city: "Reno" },
      country: "US",
      isActive: opts.active ?? true,
    })
    .returning();
  return fc!;
}

/** A tenant order, paid and routed to `fc` (fresh center by default), status `submitted`. */
export async function submittedOrder(
  opts: { fc?: { id: string; manufacturerId: string | null }; mapPartnerSkus?: boolean } = {},
) {
  const fc = opts.fc ?? (await seedCenter());
  const t = await orderReadyTenant("Fulfil");
  await privilegedDb()
    .update(skus)
    .set({ defaultFulfillmentCenterId: fc.id })
    .where(
      inArray(
        skus.id,
        t.skus.map((s) => s.id),
      ),
    );
  if (opts.mapPartnerSkus !== false)
    for (const [i, s] of t.skus.entries())
      await privilegedDb()
        .insert(partnerSkuMappings)
        .values({
          skuId: s.id,
          manufacturerId: fc.manufacturerId!,
          partnerSkuCode: `P-${i}-${s.sku}`,
        });
  const pdf = await createAsset(t.org.id, {
    kind: "label_print",
    mime: "application/pdf",
    uploadStatus: "ready",
  });
  await privilegedDb()
    .insert(labels)
    .values({
      orgId: t.org.id,
      brandId: t.brand.id,
      brandProductId: t.brandProduct.id,
      labelTemplateId: t.label.labelTemplateId,
      version: t.label.version + 1,
      status: "approved",
      printFileAssetId: pdf.id,
    });
  const { res, order } = await ingestStandardOrder(t);
  if (res.outcome !== "created") throw new Error("ingest failed");
  const admin = await createUser();
  await withTenant(t.org.id, (tx) =>
    recordOrderPayment(tx, { userId: admin.id }, res.orderId, { reference: "WIRE-1", note: null }),
  );
  await submitPaidOrder(t.org.id, res.orderId);
  return { tenant: t, orderId: res.orderId, external: order, fc, admin };
}

export async function exportedBatch() {
  const s = await submittedOrder();
  const batch = await createDispatchBatch(s.admin.id, s.fc.id);
  if (!batch || batch === "empty") throw new Error("batch not created");
  return { ...s, batch };
}
