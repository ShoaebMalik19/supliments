import { z } from "zod";

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const hex = z.string().regex(HEX_COLOR, "must be a #RRGGBB hex colour");
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/, "must be alphanumeric camelCase");
const mm = z.number().finite().nonnegative();
const positiveMm = z.number().finite().positive();

/** A rectangle in millimetres, measured from the top-left corner of the trim box. */
export const boxSchema = z.strictObject({ x: mm, y: mm, width: positiveMm, height: positiveMm });
export type Box = z.infer<typeof boxSchema>;

export const printSpecSchema = z.strictObject({
  trimWidthMm: positiveMm,
  trimHeightMm: positiveMm,
  bleedMm: mm,
  safeAreaMm: mm,
  dpi: z.int().min(72).max(1200),
  previewDpi: z.int().min(24).max(300),
  colorProfile: z.string().min(1).max(100),
});
export type PrintSpec = z.infer<typeof printSpecSchema>;

const align = z.enum(["left", "center", "right"]);

const textField = z.strictObject({
  type: z.literal("text"),
  key,
  label: z.string().min(1).max(100),
  required: z.boolean(),
  maxLength: z.int().min(1).max(500),
  box: boxSchema,
  fontSizeMm: positiveMm,
  fontWeight: z.enum(["normal", "bold"]).default("normal"),
  align: align.default("left"),
  colorField: key,
});

const colorField = z.strictObject({
  type: z.literal("color"),
  key,
  label: z.string().min(1).max(100),
  required: z.boolean(),
  target: z.enum(["background", "text"]),
  default: hex,
});

const imageField = z.strictObject({
  type: z.literal("image"),
  key,
  label: z.string().min(1).max(100),
  required: z.boolean(),
  assetKind: z.literal("logo"),
  box: boxSchema,
});

export const editableFieldSchema = z.discriminatedUnion("type", [
  textField,
  colorField,
  imageField,
]);
export type EditableField = z.infer<typeof editableFieldSchema>;
export type TextField = z.infer<typeof textField>;
export type ColorField = z.infer<typeof colorField>;
export type ImageField = z.infer<typeof imageField>;

export const fixedPanelSchema = z.strictObject({
  key,
  label: z.string().min(1).max(100),
  locked: z.literal(true),
  box: boxSchema,
  background: hex,
  textColor: hex,
  fontSizeMm: positiveMm,
  lines: z.array(z.string().max(200)).max(40),
  reserved: z.boolean().default(false),
});
export type FixedPanel = z.infer<typeof fixedPanelSchema>;

const px = z.int().positive().max(8000);

export const mockupSchema = z.strictObject({
  key,
  name: z.string().min(1).max(100),
  canvas: z.strictObject({ widthPx: px, heightPx: px }),
  background: z.strictObject({ assetId: z.uuid().nullable(), color: hex }),
  placement: z.strictObject({
    x: z.int().nonnegative(),
    y: z.int().nonnegative(),
    widthPx: px,
    heightPx: px,
    rotateDeg: z.number().min(-45).max(45).default(0),
  }),
});
export type Mockup = z.infer<typeof mockupSchema>;

export const labelTemplateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    isPlaceholder: z.boolean(),
    catalogProductId: z.uuid().nullish(),
    printSpec: printSpecSchema,
    editableFields: z.array(editableFieldSchema).min(1).max(30),
    fixedPanels: z.array(fixedPanelSchema).max(20),
    mockupSpec: z.array(mockupSchema).min(1).max(10),
  })
  .superRefine((tpl, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const { trimWidthMm: w, trimHeightMm: h, safeAreaMm: safe } = tpl.printSpec;
    const within = (b: Box, inset: number) =>
      b.x >= inset && b.y >= inset && b.x + b.width <= w - inset && b.y + b.height <= h - inset;

    if (safe * 2 >= Math.min(w, h)) issue(["printSpec", "safeAreaMm"], "safe area too large");

    const keys = [...tpl.editableFields, ...tpl.fixedPanels].map((f) => f.key);
    keys.forEach((k, i) => {
      if (keys.indexOf(k) !== i) issue(["editableFields"], `duplicate key ${k}`);
    });

    const colors = new Map(
      tpl.editableFields.flatMap((f) => (f.type === "color" ? [[f.key, f] as const] : [])),
    );
    if ([...colors.values()].filter((c) => c.target === "background").length > 1)
      issue(["editableFields"], "at most one background colour field");

    tpl.editableFields.forEach((f, i) => {
      if (f.type !== "color" && !within(f.box, safe))
        issue(["editableFields", i, "box"], "must lie inside the safe area");
      if (f.type === "text" && colors.get(f.colorField)?.target !== "text")
        issue(["editableFields", i, "colorField"], "must reference a text colour field");
    });
    tpl.fixedPanels.forEach((p, i) => {
      if (!within(p.box, 0)) issue(["fixedPanels", i, "box"], "must lie inside the trim box");
    });
    tpl.mockupSpec.forEach((m, i) => {
      const { widthPx: pw, heightPx: ph, rotateDeg, x, y } = m.placement;
      const rad = (Math.abs(rotateDeg) * Math.PI) / 180;
      const bw = pw * Math.cos(rad) + ph * Math.sin(rad);
      const bh = pw * Math.sin(rad) + ph * Math.cos(rad);
      const cx = x + pw / 2;
      const cy = y + ph / 2;
      if (
        cx - bw / 2 < 0 ||
        cy - bh / 2 < 0 ||
        cx + bw / 2 > m.canvas.widthPx ||
        cy + bh / 2 > m.canvas.heightPx
      )
        issue(["mockupSpec", i, "placement"], "placed label must fit inside the canvas");
    });
  });

export type LabelTemplateInput = z.infer<typeof labelTemplateSchema>;

/** The parts of a label_templates row the renderer and editor need. */
export type LabelTemplate = Pick<
  LabelTemplateInput,
  "printSpec" | "editableFields" | "fixedPanels" | "mockupSpec"
> & { id?: string; name: string };

export class TemplateError extends Error {}

/** Parses template JSON (a seed file or an admin request body); throws TemplateError on issues. */
export function loadLabelTemplate(json: unknown): LabelTemplateInput {
  const r = labelTemplateSchema.safeParse(json);
  if (!r.success)
    throw new TemplateError(
      r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  return r.data;
}

/** Re-validates a stored row so the renderer never trusts unchecked jsonb. */
export function templateFromRow(row: {
  id: string;
  name: string;
  isPlaceholder: boolean;
  printSpec: unknown;
  editableFields: unknown;
  fixedPanels: unknown;
  mockupSpec: unknown;
}): LabelTemplate {
  const t = loadLabelTemplate({
    name: row.name,
    isPlaceholder: row.isPlaceholder,
    printSpec: row.printSpec,
    editableFields: row.editableFields,
    fixedPanels: row.fixedPanels,
    mockupSpec: row.mockupSpec,
  });
  return { ...t, id: row.id };
}
