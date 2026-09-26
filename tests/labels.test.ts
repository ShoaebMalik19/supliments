import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import {
  assets,
  auditLogs,
  brandProducts,
  labels,
  platformAdmins,
  reviewQueueItems,
} from "@/db/schema";
import { setSessionSourceForTests } from "@/modules/auth";
import { setStorageProviderForTests } from "@/modules/assets";
import {
  createLabelDraft,
  getApprovedLabel,
  loadLabelTemplate,
  submitLabel,
  updateLabelDesign,
  type LabelTemplate,
} from "@/modules/labels";
import { approveLabel, listLabelReviewQueue, rejectLabel } from "@/modules/labels/admin";
import { resolveDesign } from "@/modules/labels/design";
import {
  labelSvg,
  mmToPt,
  pixelSize,
  renderLabelPng,
  renderMockups,
  renderPrintPdf,
} from "@/modules/labels/render";
import type { TenantContext } from "@/modules/tenancy";
import * as approveRoute from "@/app/api/admin/labels/[id]/approve/route";
import { HttpError } from "@/lib/http";
import { fakeStorage } from "./fake-storage";
import { FakeSession } from "./fake-session";
import { createAsset, createTenant, createUser, pgError } from "./helpers";
import {
  insertTemplate,
  placeholderJson,
  placeholderTemplateId,
  pngBytes,
  readyPng,
  seedLabelledBrandProduct,
  VALID_DESIGN,
} from "./label-helpers";

type Tenant = Awaited<ReturnType<typeof createTenant>>;

const session = new FakeSession();
let A: Tenant;
let B: Tenant;
let admin: { userId: string };

beforeAll(async () => {
  setSessionSourceForTests(session);
  setStorageProviderForTests(fakeStorage);
  A = await createTenant("Labels A");
  B = await createTenant("Labels B");
  const user = await createUser();
  await privilegedDb().insert(platformAdmins).values({ userId: user.id });
  admin = { userId: user.id };
});
afterAll(() => {
  setSessionSourceForTests(null);
  setStorageProviderForTests(null);
});
beforeEach(() => session.actAs(A.owner));

const ctxOf = (t: Tenant): TenantContext => ({
  userId: t.owner.id,
  email: t.owner.email,
  orgId: t.org.id,
  role: "owner",
});

const asA = <R>(fn: Parameters<typeof withTenant<R>>[1]) => withTenant(A.org.id, fn);

async function status(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, message: e.message };
    throw e;
  }
  return { status: 200, message: "" };
}

async function draftFor(tenant: Tenant = A) {
  const { brandProduct } = await seedLabelledBrandProduct(tenant);
  const label = await withTenant(tenant.org.id, (t) =>
    createLabelDraft(ctxOf(tenant), t, brandProduct.id, {}),
  );
  return { brandProduct, label: label! };
}

const save = (id: string, designState: unknown, tenant: Tenant = A) =>
  withTenant(tenant.org.id, (t) => updateLabelDesign(ctxOf(tenant), t, id, { designState }));

const submit = (id: string) => asA((t) => submitLabel(ctxOf(A), t, id));

const labelRow = async (id: string) =>
  (await privilegedDb().select().from(labels).where(eq(labels.id, id)))[0]!;
const assetRow = async (id: string) =>
  (await privilegedDb().select().from(assets).where(eq(assets.id, id)))[0]!;
const bpRow = async (id: string) =>
  (await privilegedDb().select().from(brandProducts).where(eq(brandProducts.id, id)))[0]!;
const reviewItems = (labelId: string) =>
  privilegedDb().select().from(reviewQueueItems).where(eq(reviewQueueItems.entityId, labelId));
const storedBytes = (a: { bucket: string; storageKey: string }) =>
  fakeStorage.objects.get(`${a.bucket}/${a.storageKey}`)!;

/** The placeholder, scaled to a different trim size, dpi and mockup set. */
function otherTemplateJson() {
  const json = placeholderJson() as ReturnType<typeof placeholderJson> & LabelTemplate;
  const sx = 100 / 152;
  const sy = 50 / 76;
  const scale = (b: { x: number; y: number; width: number; height: number }) => ({
    x: +(b.x * sx).toFixed(2),
    y: +(b.y * sy).toFixed(2),
    width: +(b.width * sx).toFixed(2),
    height: +(b.height * sy).toFixed(2),
  });
  return {
    ...json,
    name: "Test sachet 100×50",
    isPlaceholder: false,
    printSpec: {
      trimWidthMm: 100,
      trimHeightMm: 50,
      bleedMm: 2,
      safeAreaMm: 3,
      dpi: 150,
      previewDpi: 50,
      colorProfile: "sRGB",
    },
    editableFields: json.editableFields.map((f) => ("box" in f ? { ...f, box: scale(f.box) } : f)),
    fixedPanels: json.fixedPanels.map((p) => ({ ...p, box: scale(p.box) })),
    mockupSpec: ["a", "b", "c"].map((key) => ({
      key,
      name: key,
      canvas: { widthPx: 800, heightPx: 600 },
      background: { assetId: null, color: "#112233" },
      placement: { x: 100, y: 100, widthPx: 400, heightPx: 200, rotateDeg: 0 },
    })),
  };
}

describe("label templates are data", () => {
  it("the placeholder seed is a valid, clearly marked placeholder with ≥2 mockups", () => {
    const t = loadLabelTemplate(placeholderJson());
    expect(t.isPlaceholder).toBe(true);
    expect(t.name).toContain("PLACEHOLDER");
    expect(t.printSpec).toMatchObject({ trimWidthMm: 152, trimHeightMm: 76, bleedMm: 3, dpi: 300 });
    expect(t.mockupSpec.length).toBeGreaterThanOrEqual(2);
    expect(t.fixedPanels.every((p) => p.locked)).toBe(true);
  });

  it.each([
    ["an editable box outside the safe area", ["editableFields", 3, "box", "x"], 1],
    ["a duplicate key", ["fixedPanels", 0, "key"], "brandName"],
    ["a non-hex colour default", ["editableFields", 0, "default"], "red"],
    ["an unknown property", ["editableFields", 3, "script"], "x"],
    ["a text field coloured by a non-colour", ["editableFields", 3, "colorField"], "logo"],
    ["an unlocked fixed panel", ["fixedPanels", 0, "locked"], false],
    ["a mockup label outside its canvas", ["mockupSpec", 0, "placement", "x"], 1000],
  ] as const)("rejects %s", (_name, path, value) => {
    const json = placeholderJson();
    let node = json as Record<string | number, unknown>;
    for (const k of path.slice(0, -1)) node = node[k] as Record<string | number, unknown>;
    node[path.at(-1)!] = value;
    expect(() => loadLabelTemplate(json)).toThrow();
  });
});

describe("design_state validation (constrained editor)", () => {
  let labelId: string;
  beforeAll(async () => {
    labelId = (await draftFor()).label.id;
  });

  it.each([
    ["unknown key", { brandName: "X", fontFamily: "Comic Sans" }, "unknown field"],
    ["locked panel override", { supplementFacts: "0 calories" }, "locked panel"],
    ["text over maxLength", { brandName: "x".repeat(25) }, "max 24"],
    ["named colour", { backgroundColor: "red" }, "hex"],
    ["short hex", { textColor: "#FFF" }, "hex"],
    ["css injection in colour", { textColor: "#000000;fill:url(x)" }, "hex"],
    ["control characters", { brandName: "A\u0000B" }, "control"],
    ["non-uuid logo", { logo: "../../etc/passwd" }, "asset id"],
    ["non-string value", { brandName: 42 }, "object of string"],
  ])("rejects %s", async (_n, designState, message) => {
    const before = await labelRow(labelId);
    const res = await status(save(labelId, designState));
    expect(res.status).toBe(400);
    expect(res.message).toContain(message);
    expect(await labelRow(labelId)).toEqual(before);
  });

  it("rejects a non-object designState", async () => {
    expect((await status(save(labelId, ["brandName"]))).status).toBe(400);
  });

  it("a logo must be a ready logo asset of the caller's own org", async () => {
    const other = await readyPng(B.org.id);
    const platform = await readyPng(null);
    const pending = await createAsset(A.org.id, { kind: "logo" });
    const wrongKind = await readyPng(A.org.id, "product_image");
    for (const asset of [other, platform, pending, wrongKind]) {
      const res = await status(save(labelId, { ...VALID_DESIGN, logo: asset.id }));
      expect(res.status, asset.id).toBe(400);
    }
    const own = await readyPng(A.org.id);
    const out = await save(labelId, { ...VALID_DESIGN, logo: own.id });
    expect(out!.label.designState.logo).toBe(own.id);
  });

  it("accepts valid values, normalises hex case and stores a preview sized by the template", async () => {
    const out = await save(labelId, { ...VALID_DESIGN, backgroundColor: "#f4d35e", tagline: "" });
    expect(out!.created).toBe(false);
    expect(out!.label.designState).toEqual({ ...VALID_DESIGN, backgroundColor: "#F4D35E" });
    const preview = await assetRow(out!.label.previewAssetId!);
    const spec = loadLabelTemplate(placeholderJson()).printSpec;
    const expected = pixelSize(spec, { dpi: spec.previewDpi, includeBleed: false });
    expect(preview).toMatchObject({ kind: "label_preview", orgId: A.org.id, ...expected });
    const meta = await sharp(storedBytes(preview)).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual(expected);
  });
});

describe("label lifecycle", () => {
  it("drafts are versioned per brand product and use the catalog product's template", async () => {
    const { brandProduct, label } = await draftFor();
    expect(label).toMatchObject({ version: 1, status: "draft" });
    expect(label.labelTemplateId).toBe(await placeholderTemplateId());
    const second = await asA((t) => createLabelDraft(ctxOf(A), t, brandProduct.id, {}));
    expect(second!.version).toBe(2);
  });

  it("a draft needs a template: explicit templateId or the catalog product's", async () => {
    const { brandProduct } = await draftFor();
    const bad = await status(
      asA((t) => createLabelDraft(ctxOf(A), t, brandProduct.id, { templateId: A.org.id })),
    );
    expect(bad.status).toBe(400);
    const unknown = await status(
      asA((t) => createLabelDraft(ctxOf(A), t, brandProduct.id, { orgId: B.org.id })),
    );
    expect(unknown.status).toBe(400);
  });

  it("submit requires the template's required fields, then opens one review item", async () => {
    const { brandProduct, label } = await draftFor();
    expect((await status(submit(label.id))).message).toContain("brandName");
    await save(label.id, VALID_DESIGN);
    const submitted = await submit(label.id);
    expect(submitted!.status).toBe("submitted");
    expect((await bpRow(brandProduct.id)).status).toBe("pending_review");
    const items = await reviewItems(label.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "label_review", status: "open", orgId: A.org.id });
    expect((await status(submit(label.id))).status).toBe(409);
    expect(
      await pgError(
        privilegedDb().insert(reviewQueueItems).values({
          orgId: A.org.id,
          type: "label_review",
          entityType: "label",
          entityId: label.id,
        }),
      ),
    ).toMatch(/unique|duplicate/);
  });

  it("editing a submitted label creates a new draft version; the submitted one is untouched", async () => {
    const { label } = await draftFor();
    await save(label.id, VALID_DESIGN);
    await submit(label.id);
    const before = await labelRow(label.id);
    const out = await save(label.id, { ...VALID_DESIGN, brandName: "Acme v2" });
    expect(out!.created).toBe(true);
    expect(out!.label).toMatchObject({ version: 2, status: "draft" });
    expect(out!.label.designState.brandName).toBe("Acme v2");
    expect(await labelRow(label.id)).toEqual(before);
  });

  it("admin approval freezes print PDF + mockups, closes the review item and approves the product", async () => {
    const { brandProduct, label } = await draftFor();
    const logo = await readyPng(A.org.id);
    await save(label.id, { ...VALID_DESIGN, logo: logo.id });
    await submit(label.id);

    const approved = await approveLabel(admin, label.id);
    expect(approved).toMatchObject({ status: "approved", version: 1 });
    const row = await labelRow(label.id);
    expect(row.reviewedBy).toBe(admin.userId);
    const pdf = await assetRow(row.printFileAssetId!);
    expect(pdf).toMatchObject({ kind: "label_print", mime: "application/pdf", orgId: A.org.id });
    expect(row.mockupAssetIds).toHaveLength(2);
    for (const id of row.mockupAssetIds) {
      const m = await assetRow(id);
      expect(m).toMatchObject({ kind: "mockup", orgId: A.org.id, width: 1200, height: 1200 });
      expect(fakeStorage.has(m.bucket, m.storageKey)).toBe(true);
    }
    expect(await bpRow(brandProduct.id)).toMatchObject({
      status: "approved",
      primaryMockupAssetId: row.mockupAssetIds[0],
    });
    expect((await reviewItems(label.id))[0]!.status).toBe("done");
    const [audit] = await privilegedDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, label.id), eq(auditLogs.action, "label.approved")));
    expect(audit).toMatchObject({ actorType: "admin", actorUserId: admin.userId, orgId: A.org.id });
    expect(await asA((t) => getApprovedLabel(t, brandProduct.id))).toEqual({
      labelId: label.id,
      version: 1,
      printFileAssetId: row.printFileAssetId,
      mockupAssetIds: row.mockupAssetIds,
      previewAssetId: row.previewAssetId,
    });
    expect(await withTenant(B.org.id, (t) => getApprovedLabel(t, brandProduct.id))).toBeNull();
  });

  it("approved labels are frozen by the database; edits create a new draft", async () => {
    const { label } = await draftFor();
    await save(label.id, VALID_DESIGN);
    await submit(label.id);
    await approveLabel(admin, label.id);
    for (const change of [
      { designState: { brandName: "tampered" } },
      { printFileAssetId: null },
      { status: "draft" as const },
      { version: 9 },
    ])
      expect(
        await pgError(privilegedDb().update(labels).set(change).where(eq(labels.id, label.id))),
      ).toContain("immutable");
    const out = await save(label.id, { ...VALID_DESIGN, brandName: "Acme v2" });
    expect(out!.created).toBe(true);
    expect((await labelRow(label.id)).status).toBe("approved");
    expect((await status(approveLabel(admin, out!.label.id))).status).toBe(409);
  });

  it("re-approval supersedes the previously approved version", async () => {
    const { brandProduct, label: v1 } = await draftFor();
    await save(v1.id, VALID_DESIGN);
    await submit(v1.id);
    await approveLabel(admin, v1.id);
    const v2 = (await save(v1.id, { ...VALID_DESIGN, brandName: "Acme v2" }))!.label;
    await submit(v2.id);
    expect((await bpRow(brandProduct.id)).status).toBe("approved");
    await approveLabel(admin, v2.id);

    expect((await labelRow(v1.id)).status).toBe("superseded");
    const second = await labelRow(v2.id);
    expect(second.status).toBe("approved");
    expect((await bpRow(brandProduct.id)).primaryMockupAssetId).toBe(second.mockupAssetIds[0]);
    expect((await asA((t) => getApprovedLabel(t, brandProduct.id)))!.labelId).toBe(v2.id);
  });

  it("rejection needs a reason, records it, closes the item and returns the product to draft", async () => {
    const { brandProduct, label } = await draftFor();
    await save(label.id, VALID_DESIGN);
    await submit(label.id);
    expect((await status(rejectLabel(admin, label.id, {}))).status).toBe(400);
    const rejected = await rejectLabel(admin, label.id, { reason: "Logo is blurry" });
    expect(rejected).toMatchObject({ status: "rejected", rejectionReason: "Logo is blurry" });
    expect((await bpRow(brandProduct.id)).status).toBe("draft");
    expect((await reviewItems(label.id))[0]!.status).toBe("done");
    expect((await status(approveLabel(admin, label.id))).status).toBe(409);
  });

  it("the review queue lists open label reviews with a preview URL", async () => {
    const { label } = await draftFor(B);
    await save(label.id, VALID_DESIGN, B);
    await withTenant(B.org.id, (t) => submitLabel(ctxOf(B), t, label.id));
    const queue = await listLabelReviewQueue(admin);
    const entry = queue.find((q) => q.label.id === label.id);
    expect(entry).toMatchObject({ orgId: B.org.id });
    expect(entry!.previewUrl).toContain("ttl=60");
  });

  it("a non-admin org owner gets 404 from the approve route and the label stays submitted", async () => {
    const { label } = await draftFor();
    await save(label.id, VALID_DESIGN);
    await submit(label.id);
    session.actAs(A.owner);
    const res = await approveRoute.POST(new Request("http://test/x", { method: "POST" }), {
      params: Promise.resolve({ id: label.id }),
    });
    expect(res.status).toBe(404);
    expect((await labelRow(label.id)).status).toBe("submitted");
    expect((await reviewItems(label.id))[0]!.status).toBe("open");
  });
});

describe("renderer", () => {
  const placeholder = () => loadLabelTemplate(placeholderJson()) as LabelTemplate;
  const input = (template: LabelTemplate, design: Record<string, string> = VALID_DESIGN) => ({
    template,
    design: resolveDesign(template, design),
    images: {},
  });

  it("user text never reaches the SVG as markup: it is rendered as bundled-font paths", async () => {
    const evil = `</text><script>alert(1)</script>&"'`;
    const template = placeholder();
    const svg = await labelSvg(input(template, { brandName: evil.slice(0, 24), tagline: evil }), {
      dpi: 72,
      includeBleed: false,
    });
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("alert");
    expect(svg).not.toContain("<text");
    expect(svg).toMatch(/<path d="M/);
    const png = await renderLabelPng(input(template, { tagline: evil }), {
      dpi: 72,
      includeBleed: false,
    });
    expect((await sharp(png.data).metadata()).format).toBe("png");
  });

  it("print PDF: MediaBox = BleedBox = trim + bleed, TrimBox inset by the bleed (mm → pt)", async () => {
    const template = placeholder();
    const doc = await PDFDocument.load(await renderPrintPdf(input(template)));
    expect(doc.getPageCount()).toBe(1);
    const page = doc.getPage(0);
    const full = { x: 0, y: 0, width: mmToPt(158), height: mmToPt(82) };
    const trim = { x: mmToPt(3), y: mmToPt(3), width: mmToPt(152), height: mmToPt(76) };
    for (const [box, want] of [
      [page.getMediaBox(), full],
      [page.getBleedBox(), full],
      [page.getTrimBox(), trim],
    ] as const)
      for (const k of ["x", "y", "width", "height"] as const)
        expect(box[k]).toBeCloseTo(want[k], 3);
    expect(full.width).toBeCloseTo(447.874, 2);
  });

  it("print-resolution PNG has the spec dpi pixel dimensions (with bleed)", async () => {
    const png = await renderLabelPng(input(placeholder()), { dpi: 300, includeBleed: true });
    const meta = await sharp(png.data).metadata();
    expect([meta.width, meta.height]).toEqual([
      Math.round((158 / 25.4) * 300),
      Math.round((82 / 25.4) * 300),
    ]);
  });

  it("mockups use the background asset when present and the solid colour otherwise", async () => {
    const template = placeholder();
    const bg = await pngBytes(300, 300, "#00FF00");
    const [withAsset] = template.mockupSpec;
    const bgId = "0190a000-0000-7000-8000-000000000001";
    const mockups = await renderMockups(
      [{ ...withAsset!, background: { assetId: bgId, color: "#000000" } }, template.mockupSpec[1]!],
      (await renderLabelPng(input(template), { dpi: 100, includeBleed: false })).data,
      { [bgId]: bg },
    );
    expect(mockups).toHaveLength(2);
    const corner = async (data: Buffer) =>
      [
        ...(await sharp(data).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer()),
      ].slice(0, 3);
    expect(await corner(mockups[0]!.data)).toEqual([0, 255, 0]);
    expect(await corner(mockups[1]!.data)).toEqual([0xe4, 0xe8, 0xec]);
    for (const m of mockups) {
      const meta = await sharp(m.data).metadata();
      expect([meta.width, meta.height]).toEqual([1200, 1200]);
    }
  });

  it("nothing is hardcoded: a differently sized template drives every output", async () => {
    const template = loadLabelTemplate(otherTemplateJson()) as LabelTemplate;
    const preview = await renderLabelPng(input(template), { dpi: 50, includeBleed: false });
    expect([preview.width, preview.height]).toEqual([197, 98]);
    const meta = await sharp(preview.data).metadata();
    expect([meta.width, meta.height]).toEqual([197, 98]);

    const page = (await PDFDocument.load(await renderPrintPdf(input(template)))).getPage(0);
    expect(page.getMediaBox().width).toBeCloseTo(mmToPt(104), 3);
    expect(page.getMediaBox().height).toBeCloseTo(mmToPt(54), 3);
    expect(page.getTrimBox().x).toBeCloseTo(mmToPt(2), 3);
    expect(page.getTrimBox().width).toBeCloseTo(mmToPt(100), 3);

    const mockups = await renderMockups(template.mockupSpec, preview.data, {});
    expect(mockups).toHaveLength(3);
    for (const m of mockups) {
      const mm = await sharp(m.data).metadata();
      expect([mm.width, mm.height]).toEqual([800, 600]);
    }
  });

  it("the full pipeline follows the label's own template (DB flow)", async () => {
    const templateId = await insertTemplate(otherTemplateJson());
    const { brandProduct } = await seedLabelledBrandProduct(A);
    const label = await asA((t) => createLabelDraft(ctxOf(A), t, brandProduct.id, { templateId }));
    await save(label!.id, VALID_DESIGN);
    const saved = await labelRow(label!.id);
    expect(await assetRow(saved.previewAssetId!)).toMatchObject({ width: 197, height: 98 });
    await submit(label!.id);
    await approveLabel(admin, label!.id);
    const row = await labelRow(label!.id);
    expect(row.mockupAssetIds).toHaveLength(3);
    const pdf = await PDFDocument.load(storedBytes(await assetRow(row.printFileAssetId!)));
    expect(pdf.getPage(0).getMediaBox().width).toBeCloseTo(mmToPt(104), 3);
  });
});
