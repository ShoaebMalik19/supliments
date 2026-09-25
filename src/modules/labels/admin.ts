import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { catalogProducts, labels, labelTemplates } from "@/db/schema";
import { closeReviewItem, listOpenReviewItems, type AdminContext } from "@/modules/admin";
import { downloadUrl } from "@/modules/assets";
import { recordAudit } from "@/modules/audit";
import { badRequest } from "@/lib/http";
import { approveSubmittedLabel, getLabel, labelView, rejectSubmittedLabel } from "./index";
import { loadLabelTemplate, TemplateError } from "./template";

/** Privileged (cross-tenant) label entry points for platform admins. Every call is audited. */

const isUuid = (id: string) => z.uuid().safeParse(id).success;

async function labelOwner(id: string) {
  if (!isUuid(id)) return null;
  const [row] = await privilegedDb()
    .select({ orgId: labels.orgId, status: labels.status })
    .from(labels)
    .where(eq(labels.id, id));
  return row ?? null;
}

/** `admin` null = the seed script (audited as a system action). */
export async function createLabelTemplate(admin: AdminContext | null, raw: unknown) {
  let input;
  try {
    input = loadLabelTemplate(raw);
  } catch (e) {
    if (e instanceof TemplateError) throw badRequest(e.message);
    throw e;
  }
  return privilegedDb().transaction(async (tx) => {
    if (input.catalogProductId) {
      const [p] = await tx
        .select({ id: catalogProducts.id })
        .from(catalogProducts)
        .where(eq(catalogProducts.id, input.catalogProductId));
      if (!p) throw badRequest("Unknown catalogProductId");
    }
    const [row] = await tx
      .insert(labelTemplates)
      .values({
        name: input.name,
        isPlaceholder: input.isPlaceholder,
        catalogProductId: input.catalogProductId ?? null,
        printSpec: input.printSpec,
        editableFields: input.editableFields,
        fixedPanels: input.fixedPanels,
        mockupSpec: input.mockupSpec,
      })
      .returning();
    await recordAudit(
      {
        orgId: null,
        actorUserId: admin?.userId ?? null,
        actorType: admin ? "admin" : "system",
        action: "admin.label_template_created",
        entityType: "label_template",
        entityId: row!.id,
        after: { name: row!.name, isPlaceholder: row!.isPlaceholder },
      },
      tx,
    );
    return row!;
  });
}

/** Open label reviews across all tenants, oldest first, with a short-lived preview URL. */
export async function listLabelReviewQueue(admin: AdminContext) {
  const items = await listOpenReviewItems("label_review");
  const ids = items.map((i) => i.entityId);
  const rows = ids.length
    ? await privilegedDb().select().from(labels).where(inArray(labels.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  await recordAudit({
    orgId: null,
    actorUserId: admin.userId,
    actorType: "admin",
    action: "admin.label_queue_listed",
    after: { count: items.length },
  });
  const out = [];
  for (const item of items) {
    const label = byId.get(item.entityId);
    if (!label) continue;
    const preview = label.previewAssetId
      ? await withTenant(label.orgId, (t) => downloadUrl(t, label.previewAssetId!))
      : null;
    out.push({
      reviewItemId: item.id,
      openedAt: item.createdAt,
      orgId: label.orgId,
      label: labelView(label),
      previewUrl: preview?.url ?? null,
    });
  }
  return out;
}

/**
 * Approves a submitted label in its tenant's context, then closes the review item. Retrying
 * an already-approved label only closes a review item left open by a failed earlier attempt.
 */
export async function approveLabel(admin: AdminContext, id: string) {
  const owner = await labelOwner(id);
  if (!owner) return null;
  const label =
    owner.status === "approved"
      ? await withTenant(owner.orgId, (t) => getLabel(t, id))
      : await withTenant(owner.orgId, (t) => approveSubmittedLabel(admin, t, id));
  await closeReviewItem("label_review", id, "done");
  return label;
}

const rejectInput = z.strictObject({ reason: z.string().trim().min(3).max(2000) });

export async function rejectLabel(admin: AdminContext, id: string, raw: unknown) {
  const owner = await labelOwner(id);
  if (!owner) return null;
  const body = rejectInput.safeParse(raw);
  if (!body.success) throw badRequest("reason is required (3–2000 chars)");
  const label = await withTenant(owner.orgId, (t) =>
    rejectSubmittedLabel(admin, t, id, body.data.reason),
  );
  await closeReviewItem("label_review", id, "done");
  return label;
}
