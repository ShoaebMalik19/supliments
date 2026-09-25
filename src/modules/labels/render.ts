import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import type { DesignState } from "./design";
import type { Box, FixedPanel, LabelTemplate, Mockup, PrintSpec, TextField } from "./template";

/**
 * The single authoritative renderer. Every dimension comes from the template's print spec
 * (mm) and the requested dpi; nothing about a label's geometry lives in code.
 */

const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;
const FONT_FAMILY = "DejaVu Sans, Helvetica, Arial, sans-serif";
/** Conservative average advance width; text is shrunk so it never overflows its box. */
const GLYPH_WIDTH_EM = { normal: 0.65, bold: 0.75 } as const;

export const mmToPx = (mm: number, dpi: number) => (mm / MM_PER_INCH) * dpi;
export const mmToPt = (mm: number) => (mm / MM_PER_INCH) * PT_PER_INCH;

export type RenderInput = {
  template: LabelTemplate;
  design: DesignState;
  /** Logo bytes keyed by image-field key (any format sharp can decode). */
  images: Record<string, Uint8Array>;
};

export type RenderOptions = { dpi: number; includeBleed: boolean };

export function pixelSize(spec: PrintSpec, opts: RenderOptions) {
  const extra = opts.includeBleed ? spec.bleedMm * 2 : 0;
  return {
    width: Math.round(mmToPx(spec.trimWidthMm + extra, opts.dpi)),
    height: Math.round(mmToPx(spec.trimHeightMm + extra, opts.dpi)),
  };
}

export function escapeXml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const n = (v: number) => Number(v.toFixed(4)).toString();
const rect = (b: Box) =>
  `x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}"`;

function textElement(
  text: string,
  box: Box,
  o: {
    fontSizeMm: number;
    weight: keyof typeof GLYPH_WIDTH_EM;
    align: TextField["align"];
    color: string;
    y?: number;
  },
) {
  const glyphs = Math.max([...text].length, 1);
  const size = Math.min(o.fontSizeMm, box.height, box.width / (glyphs * GLYPH_WIDTH_EM[o.weight]));
  const anchor = { left: "start", center: "middle", right: "end" }[o.align];
  const x = { left: box.x, center: box.x + box.width / 2, right: box.x + box.width }[o.align];
  const y = o.y ?? box.y + box.height / 2 + size * 0.35;
  return (
    `<text x="${n(x)}" y="${n(y)}" font-family="${FONT_FAMILY}" font-size="${n(size)}" ` +
    `font-weight="${o.weight}" fill="${escapeXml(o.color)}" text-anchor="${anchor}">` +
    `${escapeXml(text)}</text>`
  );
}

function panelElement(p: FixedPanel, id: string) {
  const stroke = Math.min(p.box.width, p.box.height) / 150;
  const lineHeight = p.fontSizeMm * 1.3;
  const inset = { ...p.box, x: p.box.x + p.fontSizeMm * 0.5, width: p.box.width - p.fontSizeMm };
  const centered = p.reserved || p.lines.length === 1;
  const lines = p.lines.map((line, i) =>
    textElement(line, centered ? p.box : inset, {
      fontSizeMm: p.fontSizeMm,
      weight: i === 0 ? "bold" : "normal",
      align: centered ? "center" : "left",
      color: p.textColor,
      y: centered ? undefined : p.box.y + lineHeight * (i + 1),
    }),
  );
  return (
    `<g clip-path="url(#${id})"><rect ${rect(p.box)} fill="${escapeXml(p.background)}" ` +
    `stroke="${escapeXml(p.textColor)}" stroke-width="${n(stroke)}"` +
    `${p.reserved ? ` stroke-dasharray="${n(stroke * 4)}"` : ""}/>${lines.join("")}</g>`
  );
}

async function toPngDataUri(data: Uint8Array) {
  const png = await sharp(data).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** SVG in mm user units, sized in pixels for `dpi`. Coordinates are relative to the trim box. */
export async function labelSvg(input: RenderInput, opts: RenderOptions): Promise<string> {
  const { template, design } = input;
  const spec = template.printSpec;
  const { width, height } = pixelSize(spec, opts);
  const b = opts.includeBleed ? spec.bleedMm : 0;
  const view = `${n(-b)} ${n(-b)} ${n(spec.trimWidthMm + 2 * b)} ${n(spec.trimHeightMm + 2 * b)}`;

  const clips: string[] = [];
  const body: string[] = [];
  const clipFor = (box: Box) => {
    const id = `c${clips.length}`;
    clips.push(`<clipPath id="${id}"><rect ${rect(box)}/></clipPath>`);
    return id;
  };

  const background = template.editableFields.find(
    (f) => f.type === "color" && f.target === "background",
  );
  const bg = background ? design[background.key] : "#FFFFFF";
  body.push(
    `<rect x="${n(-spec.bleedMm)}" y="${n(-spec.bleedMm)}" ` +
      `width="${n(spec.trimWidthMm + 2 * spec.bleedMm)}" ` +
      `height="${n(spec.trimHeightMm + 2 * spec.bleedMm)}" fill="${escapeXml(bg ?? "#FFFFFF")}"/>`,
  );

  for (const f of template.editableFields) {
    if (f.type === "image") {
      const bytes = input.images[f.key];
      if (!bytes) continue;
      body.push(
        `<image ${rect(f.box)} preserveAspectRatio="xMidYMid meet" ` +
          `xlink:href="${await toPngDataUri(bytes)}"/>`,
      );
    } else if (f.type === "text") {
      const text = design[f.key];
      if (!text) continue;
      body.push(
        `<g clip-path="url(#${clipFor(f.box)})">` +
          textElement(text, f.box, {
            fontSizeMm: f.fontSizeMm,
            weight: f.fontWeight,
            align: f.align,
            color: design[f.colorField] ?? "#000000",
          }) +
          `</g>`,
      );
    }
  }
  for (const p of template.fixedPanels) body.push(panelElement(p, clipFor(p.box)));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${width}" height="${height}" viewBox="${view}">` +
    `<defs>${clips.join("")}</defs>${body.join("")}</svg>`
  );
}

export async function renderLabelPng(input: RenderInput, opts: RenderOptions) {
  const { width, height } = pixelSize(input.template.printSpec, opts);
  const svg = await labelSvg(input, opts);
  const data = await sharp(Buffer.from(svg))
    .resize(width, height, { fit: "fill" })
    .flatten({ background: "#FFFFFF" })
    .png()
    .toBuffer();
  return { data, width, height };
}

/**
 * Print-ready PDF at the spec dpi: MediaBox = BleedBox = trim + bleed, TrimBox inset by the
 * bleed. MVP limitation: the artwork is a single raster image and no PDF/X OutputIntent is
 * embedded (the colour profile is recorded in the document metadata only).
 */
export async function renderPrintPdf(input: RenderInput): Promise<Uint8Array> {
  const spec = input.template.printSpec;
  const png = await renderLabelPng(input, { dpi: spec.dpi, includeBleed: true });
  const w = mmToPt(spec.trimWidthMm + 2 * spec.bleedMm);
  const h = mmToPt(spec.trimHeightMm + 2 * spec.bleedMm);
  const bleed = mmToPt(spec.bleedMm);

  const doc = await PDFDocument.create();
  doc.setTitle(input.template.name);
  doc.setSubject(`Output intent: ${spec.colorProfile}; ${spec.dpi} dpi`);
  doc.setProducer("labels/render");
  const page = doc.addPage([w, h]);
  page.drawImage(await doc.embedPng(png.data), { x: 0, y: 0, width: w, height: h });
  page.setMediaBox(0, 0, w, h);
  page.setBleedBox(0, 0, w, h);
  page.setTrimBox(bleed, bleed, mmToPt(spec.trimWidthMm), mmToPt(spec.trimHeightMm));
  return doc.save();
}

/** Composites the flat (trimmed) label onto each mockup of the template. */
export async function renderMockups(
  mockups: Mockup[],
  label: Uint8Array,
  backgrounds: Record<string, Uint8Array>,
) {
  const out: { key: string; data: Buffer; width: number; height: number }[] = [];
  for (const m of mockups) {
    const { widthPx: W, heightPx: H } = m.canvas;
    const bg = m.background.assetId ? backgrounds[m.background.assetId] : undefined;
    const base = bg
      ? sharp(bg).resize(W, H, { fit: "cover" })
      : sharp({ create: { width: W, height: H, channels: 4, background: m.background.color } });

    const p = m.placement;
    let placed = await sharp(label).resize(p.widthPx, p.heightPx, { fit: "fill" }).png().toBuffer();
    if (p.rotateDeg)
      placed = await sharp(placed)
        .rotate(p.rotateDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    const meta = await sharp(placed).metadata();
    const lw = Math.min(meta.width, W);
    const lh = Math.min(meta.height, H);
    const clamp = (v: number, max: number) => Math.min(Math.max(0, Math.round(v)), max);
    const left = clamp(p.x + p.widthPx / 2 - lw / 2, W - lw);
    const top = clamp(p.y + p.heightPx / 2 - lh / 2, H - lh);
    if (lw !== meta.width || lh !== meta.height)
      placed = await sharp(placed).resize(lw, lh, { fit: "fill" }).png().toBuffer();

    const data = await sharp(await base.png().toBuffer())
      .composite([{ input: placed, left, top }])
      .png()
      .toBuffer();
    out.push({ key: m.key, data, width: W, height: H });
  }
  return out;
}
