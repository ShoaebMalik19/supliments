import { and, eq, max, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantDb } from "@/db/tenant";
import { labels, labelTemplates } from "@/db/schema";
import { openReviewItem, type AdminContext } from "@/modules/admin";
import { readAssetBytes, storeGeneratedAsset } from "@/modules/assets";
import { recordAudit } from "@/modules/audit";
import {
  findBrandProduct,
  setBrandProductLabelState,
  type BrandProductStatus,
} from "@/modules/branding";
import { getActiveProduct } from "@/modules/catalog";
import type { TenantContext } from "@/modules/tenancy";
import { badRequest, HttpError, notFound } from "@/lib/http";
import {
  logoFields,
  missingRequired,
  parseDesignState,
  resolveDesign,
  type DesignState,
} from "./design";
import { renderLabelPng, renderMockups, renderPrintPdf } from "./render";
import { templateFromRow, type LabelTemplate } from "./template";

export { loadLabelTemplate, TemplateError, type LabelTemplate } from "./template";
export type { DesignState } from "./design";

type Label = typeof labels.$inferSelect;
type Actor = { userId: string; actorType: "user" | "admin" };

const conflict = (msg: string) => new HttpError(409, msg);
const LOGO_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function labelView(l: Label) {
  return {
    id: l.id,
    brandId: l.brandId,
    brandProductId: l.brandProductId,
    labelTemplateId: l.labelTemplateId,
    version: l.version,
    status: l.status,
    designState: l.designState as DesignState,
    previewAssetId: l.previewAssetId,
    printFileAssetId: l.printFileAssetId,
    mockupAssetIds: l.mockupAssetIds,
    rejectionReason: l.rejectionReason,
    reviewedAt: l.reviewedAt,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}
export type LabelView = ReturnType<typeof labelView>;

async function loadTemplate(t: TenantDb, id: string): Promise<LabelTemplate | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await t.tx.select().from(labelTemplates).where(eq(labelTemplates.id, id));
  return row ? templateFromRow(row) : null;
}

async function lockLabel(t: TenantDb, id: string): Promise<Label | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await t.tx
    .select()
    .from(labels)
    .where(and(eq(labels.id, id), eq(labels.orgId, t.orgId)))
    .for("update");
  return row ?? null;
}

/** Logo bytes for every image field; each must be a ready logo asset of the caller's own org. */
async function loadLogos(t: TenantDb, template: LabelTemplate, design: DesignState) {
  const images: Record<string, Uint8Array> = {};
  for (const f of logoFields(template)) {
    const id = design[f.key];
    if (!id) continue;
    const found = await readAssetBytes(t, id);
    if (
      !found ||
      found.asset.orgId !== t.orgId ||
      found.asset.kind !== f.assetKind ||
      !LOGO_MIMES.has(found.asset.mime)
    )
      throw badRequest(`${f.key}: must be a ready PNG/JPEG/WebP logo asset of your organization`);
    images[f.key] = found.data;
  }
  return images;
}

async function renderPreview(
  t: TenantDb,
  template: LabelTemplate,
  design: DesignState,
  images: Record<string, Uint8Array>,
) {
  const png = await renderLabelPng(
    { template, design: resolveDesign(template, design), images },
    { dpi: template.printSpec.previewDpi, includeBleed: false },
  );
  return storeGeneratedAsset(t, {
    kind: "label_preview",
    mime: "image/png",
    data: png.data,
    width: png.width,
    height: png.height,
  });
}

async function insertVersion(
  actor: Actor,
  t: TenantDb,
  bp: { id: string; brandId: string },
  templateId: string,
  template: LabelTemplate,
  design: DesignState,
  clonedFrom: Label | null,
) {
  await t.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${bp.id}, 0))`);
  const [{ current }] = (await t.tx
    .select({ current: max(labels.version) })
    .from(labels)
    .where(and(eq(labels.brandProductId, bp.id), eq(labels.orgId, t.orgId)))) as [
    { current: number | null },
  ];
  const images = await loadLogos(t, template, design);
  const preview = await renderPreview(t, template, design, images);
  const label = await t.insert(labels, {
    brandId: bp.brandId,
    brandProductId: bp.id,
    labelTemplateId: templateId,
    version: (current ?? 0) + 1,
    designState: design,
    previewAssetId: preview.id,
  });
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: actor.userId,
      actorType: actor.actorType,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      after: { version: label.version, clonedFrom: clonedFrom?.id ?? null, designState: design },
    },
    t.tx,
  );
  return label;
}

const createInput = z.strictObject({ templateId: z.uuid().optional() });

/**
 * New draft version for a brand product: template = explicit `templateId` or the catalog
 * product's label template. Returns null when the brand product is not the caller's.
 */
export async function createLabelDraft(
  ctx: TenantContext,
  t: TenantDb,
  brandProductId: string,
  raw: unknown,
) {
  const bp = await findBrandProduct(t, brandProductId);
  if (!bp) return null;
  const parsed = createInput.safeParse(raw ?? {});
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  const templateId =
    parsed.data.templateId ??
    (await getActiveProduct(t, bp.catalogProductId))?.labelTemplateId ??
    null;
  if (!templateId) throw conflict("No label template for this product; pass templateId");
  const template = await loadTemplate(t, templateId);
  if (!template) throw badRequest("Unknown label template");
  const label = await insertVersion(
    { userId: ctx.userId, actorType: "user" },
    t,
    bp,
    templateId,
    template,
    {},
    null,
  );
  return labelView(label);
}

export async function listLabels(t: TenantDb, brandProductId: string) {
  const rows = await t.list(labels, eq(labels.brandProductId, brandProductId));
  return rows.sort((a, b) => b.version - a.version).map(labelView);
}

/** Label plus the template parts an editor needs to build its form. */
export async function getLabel(t: TenantDb, id: string) {
  const label = await t.find(labels, id);
  if (!label) return null;
  const template = await loadTemplate(t, label.labelTemplateId);
  if (!template) throw new Error(`label ${id} references a missing template`);
  return {
    ...labelView(label),
    template: {
      id: label.labelTemplateId,
      name: template.name,
      printSpec: template.printSpec,
      editableFields: template.editableFields,
      lockedPanels: template.fixedPanels.map((p) => ({ key: p.key, label: p.label })),
    },
  };
}

const updateInput = z.strictObject({ designState: z.unknown() });

/**
 * Saves a design. Drafts are edited in place; editing a submitted, approved, rejected or
 * superseded label creates a new draft version with the edits (`created: true`).
 */
export async function updateLabelDesign(
  ctx: TenantContext,
  t: TenantDb,
  id: string,
  raw: unknown,
): Promise<{ created: boolean; label: LabelView } | null> {
  const label = await lockLabel(t, id);
  if (!label) return null;
  const body = updateInput.safeParse(raw);
  if (!body.success) throw badRequest("body must be { designState }");
  const template = await loadTemplate(t, label.labelTemplateId);
  if (!template) throw notFound();
  const design = parseDesignState(template, body.data.designState);
  const actor: Actor = { userId: ctx.userId, actorType: "user" };

  if (label.status !== "draft") {
    const bp = await findBrandProduct(t, label.brandProductId);
    if (!bp) throw notFound();
    const created = await insertVersion(
      actor,
      t,
      bp,
      label.labelTemplateId,
      template,
      design,
      label,
    );
    return { created: true, label: labelView(created) };
  }

  const images = await loadLogos(t, template, design);
  const preview = await renderPreview(t, template, design, images);
  const updated = (await t.update(labels, id, {
    designState: design,
    previewAssetId: preview.id,
  }))!;
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "label.design_updated",
      entityType: "label",
      entityId: id,
      before: { designState: label.designState },
      after: { designState: design },
    },
    t.tx,
  );
  return { created: false, label: labelView(updated) };
}

export async function submitLabel(ctx: TenantContext, t: TenantDb, id: string) {
  const label = await lockLabel(t, id);
  if (!label) return null;
  if (label.status !== "draft") throw conflict(`Only drafts can be submitted (is ${label.status})`);
  const template = await loadTemplate(t, label.labelTemplateId);
  if (!template) throw notFound();
  const design = parseDesignState(template, label.designState);
  const missing = missingRequired(template, design);
  if (missing.length) throw badRequest(`required: ${missing.join(", ")}`);
  await loadLogos(t, template, design);

  const updated = (await t.update(labels, id, { status: "submitted" }))!;
  const bp = await findBrandProduct(t, label.brandProductId);
  if (bp?.status === "draft")
    await setBrandProductLabelState(t, bp.id, { status: "pending_review" });
  await openReviewItem(t, { type: "label_review", entityType: "label", entityId: id });
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "label.submitted",
      entityType: "label",
      entityId: id,
      after: { version: label.version },
    },
    t.tx,
  );
  return labelView(updated);
}

/**
 * Admin approval, run inside withTenant(label.orgId): freezes the print PDF and mockups,
 * supersedes the previously approved version and marks the brand product approved.
 */
export async function approveSubmittedLabel(admin: AdminContext, t: TenantDb, id: string) {
  const label = await lockLabel(t, id);
  if (!label) return null;
  if (label.status !== "submitted")
    throw conflict(`Only submitted labels can be approved (is ${label.status})`);
  const template = await loadTemplate(t, label.labelTemplateId);
  if (!template) throw notFound();
  const design = resolveDesign(template, label.designState);
  const input = { template, design, images: await loadLogos(t, template, design) };

  const pdf = await storeGeneratedAsset(t, {
    kind: "label_print",
    mime: "application/pdf",
    data: await renderPrintPdf(input),
  });
  const flat = await renderLabelPng(input, { dpi: template.printSpec.dpi, includeBleed: false });
  const backgrounds: Record<string, Uint8Array> = {};
  for (const m of template.mockupSpec) {
    const bgId = m.background.assetId;
    if (!bgId || backgrounds[bgId]) continue;
    const found = await readAssetBytes(t, bgId);
    if (!found || found.asset.orgId !== null)
      throw conflict(`Mockup background ${bgId} is not a ready platform asset`);
    backgrounds[bgId] = found.data;
  }
  const mockups = [];
  for (const m of await renderMockups(template.mockupSpec, flat.data, backgrounds))
    mockups.push(
      await storeGeneratedAsset(t, {
        kind: "mockup",
        mime: "image/png",
        data: m.data,
        width: m.width,
        height: m.height,
      }),
    );

  const superseded = await t.tx
    .update(labels)
    .set({ status: "superseded" })
    .where(
      and(
        eq(labels.orgId, t.orgId),
        eq(labels.brandProductId, label.brandProductId),
        eq(labels.status, "approved"),
        ne(labels.id, id),
      ),
    )
    .returning({ id: labels.id, version: labels.version });
  const approved = (await t.update(labels, id, {
    status: "approved",
    printFileAssetId: pdf.id,
    mockupAssetIds: mockups.map((m) => m.id),
    reviewedBy: admin.userId,
    reviewedAt: new Date(),
    rejectionReason: null,
  }))!;
  const bp = await findBrandProduct(t, label.brandProductId);
  if (bp) {
    const keep: BrandProductStatus[] = ["published", "unpublished", "archived"];
    await setBrandProductLabelState(t, bp.id, {
      status: keep.includes(bp.status) ? bp.status : "approved",
      primaryMockupAssetId: mockups[0]?.id,
    });
  }
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: admin.userId,
      actorType: "admin",
      action: "label.approved",
      entityType: "label",
      entityId: id,
      after: {
        version: label.version,
        printFileAssetId: pdf.id,
        mockupAssetIds: approved.mockupAssetIds,
        superseded,
      },
    },
    t.tx,
  );
  return labelView(approved);
}

export async function rejectSubmittedLabel(
  admin: AdminContext,
  t: TenantDb,
  id: string,
  reason: string,
) {
  const label = await lockLabel(t, id);
  if (!label) return null;
  if (label.status !== "submitted")
    throw conflict(`Only submitted labels can be rejected (is ${label.status})`);
  const rejected = (await t.update(labels, id, {
    status: "rejected",
    rejectionReason: reason,
    reviewedBy: admin.userId,
    reviewedAt: new Date(),
  }))!;
  const bp = await findBrandProduct(t, label.brandProductId);
  if (bp?.status === "pending_review")
    await setBrandProductLabelState(t, bp.id, { status: "draft" });
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: admin.userId,
      actorType: "admin",
      action: "label.rejected",
      entityType: "label",
      entityId: id,
      after: { version: label.version, reason },
    },
    t.tx,
  );
  return labelView(rejected);
}

/**
 * The approved (frozen) label of a brand product, for publishing and order routing:
 * mockup asset ids are the store images, the print file is what the manufacturer prints.
 */
export async function getApprovedLabel(t: TenantDb, brandProductId: string) {
  const [row] = await t.list(
    labels,
    and(eq(labels.brandProductId, brandProductId), eq(labels.status, "approved")),
  );
  if (!row) return null;
  return {
    labelId: row.id,
    version: row.version,
    printFileAssetId: row.printFileAssetId!,
    mockupAssetIds: row.mockupAssetIds,
    previewAssetId: row.previewAssetId,
  };
}
