import { readFileSync } from "node:fs";
import { join } from "node:path";
import opentype from "opentype.js";
import sharp from "sharp";
import {
  clip,
  endPath,
  PDFDocument,
  PDFName,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
} from "pdf-lib";
import type { DesignState } from "./design";
import type { Box, FixedPanel, LabelTemplate, Mockup, PrintSpec, TextField } from "./template";

/**
 * The single authoritative renderer. Every dimension comes from the template's print spec
 * (mm) and the requested dpi; nothing about a label's geometry lives in code.
 */

const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;
/**
 * Text is converted to vector paths with a font bundled in the repo (`assets/fonts`), so the
 * rasterizer never resolves fonts from the host: output is identical on every machine.
 */
export const FONT_DIR = join(process.cwd(), "assets", "fonts");
const FONT_FILES = { normal: "DejaVuSans.ttf", bold: "DejaVuSans-Bold.ttf" } as const;
type Weight = keyof typeof FONT_FILES;
const fonts: Partial<Record<Weight, opentype.Font>> = {};

function font(weight: Weight): opentype.Font {
  const buf = fonts[weight] ? null : readFileSync(join(FONT_DIR, FONT_FILES[weight]));
  if (buf)
    fonts[weight] = opentype.parse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
  return fonts[weight]!;
}

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

type TextOpts = {
  fontSizeMm: number;
  weight: Weight;
  align: TextField["align"];
  color: string;
  y?: number;
};

/** Glyph outlines (mm, y down, trim-relative) for one line fitted into its box. */
function textPathData(text: string, box: Box, o: TextOpts) {
  const f = font(o.weight);
  const widthAt1 = Math.max(f.getAdvanceWidth(text, 1), 1e-6);
  const size = Math.min(o.fontSizeMm, box.height, box.width / widthAt1);
  const width = widthAt1 * size;
  const x = {
    left: box.x,
    center: box.x + (box.width - width) / 2,
    right: box.x + box.width - width,
  }[o.align];
  const y = o.y ?? box.y + box.height / 2 + size * 0.35;
  return f.getPath(text, x, y, size).toPathData(4);
}

function textElement(text: string, box: Box, o: TextOpts) {
  const d = textPathData(text, box, o);
  return d ? `<path d="${d}" fill="${escapeXml(o.color)}"/>` : "";
}

const panelStroke = (p: FixedPanel) => Math.min(p.box.width, p.box.height) / 150;

function panelLines(p: FixedPanel): { text: string; box: Box; opts: TextOpts }[] {
  const lineHeight = p.fontSizeMm * 1.3;
  const inset = { ...p.box, x: p.box.x + p.fontSizeMm * 0.5, width: p.box.width - p.fontSizeMm };
  const centered = p.reserved || p.lines.length === 1;
  return p.lines.map((line, i) => ({
    text: line,
    box: centered ? p.box : inset,
    opts: {
      fontSizeMm: p.fontSizeMm,
      weight: i === 0 ? "bold" : "normal",
      align: centered ? "center" : "left",
      color: p.textColor,
      y: centered ? undefined : p.box.y + lineHeight * (i + 1),
    },
  }));
}

function panelElement(p: FixedPanel, id: string) {
  const stroke = panelStroke(p);
  const lines = panelLines(p).map((l) => textElement(l.text, l.box, l.opts));
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
 * Print-ready vector PDF: MediaBox = BleedBox = trim + bleed, TrimBox inset by the bleed. Shapes
 * and text (glyph outlines from the bundled font) are vector; logos are embedded at their own
 * resolution. Colours are RGB with an embedded sRGB OutputIntent (GTS_PDFX): the printer converts
 * to its press profile (the template's `colorProfile`) at prepress.
 */
export async function renderPrintPdf(input: RenderInput): Promise<Uint8Array> {
  const { template, design } = input;
  const spec = template.printSpec;
  const s = mmToPt(1);
  const b = spec.bleedMm;
  const w = mmToPt(spec.trimWidthMm + 2 * b);
  const h = mmToPt(spec.trimHeightMm + 2 * b);
  const X = (mm: number) => (mm + b) * s;
  const Y = (mm: number) => h - (mm + b) * s;

  const doc = await PDFDocument.create();
  doc.setTitle(template.name);
  doc.setSubject(`Press profile: ${spec.colorProfile}`);
  doc.setProducer("labels/render");
  doc.setCreator("labels/render");
  await addSrgbOutputIntent(doc);
  const page = doc.addPage([w, h]);
  const clipTo = (box: Box, draw: () => void) => {
    page.pushOperators(
      pushGraphicsState(),
      rectangle(X(box.x), Y(box.y + box.height), box.width * s, box.height * s),
      clip(),
      endPath(),
    );
    draw();
    page.pushOperators(popGraphicsState());
  };
  const drawText = (text: string, box: Box, opts: TextOpts) => {
    const d = textPathData(text, box, opts);
    if (d) page.drawSvgPath(d, { x: X(0), y: Y(0), scale: s, color: pdfColor(opts.color) });
  };

  const background = template.editableFields.find(
    (f) => f.type === "color" && f.target === "background",
  );
  page.drawRectangle({
    x: 0,
    y: 0,
    width: w,
    height: h,
    color: pdfColor((background && design[background.key]) || "#FFFFFF"),
  });

  for (const f of template.editableFields) {
    if (f.type === "image") {
      const bytes = input.images[f.key];
      if (!bytes) continue;
      const png = await sharp(bytes).png().toBuffer();
      const img = await doc.embedPng(png);
      const fit = Math.min(f.box.width / img.width, f.box.height / img.height);
      const iw = img.width * fit;
      const ih = img.height * fit;
      page.drawImage(img, {
        x: X(f.box.x + (f.box.width - iw) / 2),
        y: Y(f.box.y + (f.box.height + ih) / 2),
        width: iw * s,
        height: ih * s,
      });
    } else if (f.type === "text") {
      const text = design[f.key];
      if (!text) continue;
      clipTo(f.box, () =>
        drawText(text, f.box, {
          fontSizeMm: f.fontSizeMm,
          weight: f.fontWeight,
          align: f.align,
          color: design[f.colorField] ?? "#000000",
        }),
      );
    }
  }
  for (const p of template.fixedPanels) {
    const stroke = panelStroke(p);
    clipTo(p.box, () => {
      page.drawRectangle({
        x: X(p.box.x),
        y: Y(p.box.y + p.box.height),
        width: p.box.width * s,
        height: p.box.height * s,
        color: pdfColor(p.background),
        borderColor: pdfColor(p.textColor),
        borderWidth: stroke * s,
        borderDashArray: p.reserved ? [stroke * 4 * s] : undefined,
      });
      for (const l of panelLines(p)) drawText(l.text, l.box, l.opts);
    });
  }

  page.setMediaBox(0, 0, w, h);
  page.setBleedBox(0, 0, w, h);
  page.setTrimBox(mmToPt(b), mmToPt(b), mmToPt(spec.trimWidthMm), mmToPt(spec.trimHeightMm));
  return doc.save();
}

export function pdfColor(hex: string) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return rgb(0, 0, 0);
  const full = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  const v = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return rgb(v(0), v(2), v(4));
}

let srgbIcc: Buffer | null = null;
async function srgbProfile() {
  if (!srgbIcc) {
    const probe = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } })
      .withIccProfile("srgb")
      .png()
      .toBuffer();
    const icc = (await sharp(probe).metadata()).icc;
    if (!icc) throw new Error("sRGB ICC profile unavailable from the image library");
    srgbIcc = icc;
  }
  return srgbIcc;
}

async function addSrgbOutputIntent(doc: PDFDocument) {
  const profile = doc.context.flateStream(await srgbProfile(), { N: 3 });
  const profileRef = doc.context.register(profile);
  const intent = doc.context.obj({
    Type: "OutputIntent",
    S: "GTS_PDFX",
    OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"),
    Info: PDFString.of("sRGB IEC61966-2.1"),
    RegistryName: PDFString.of("http://www.color.org"),
    DestOutputProfile: profileRef,
  });
  doc.catalog.set(PDFName.of("OutputIntents"), doc.context.obj([doc.context.register(intent)]));
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
