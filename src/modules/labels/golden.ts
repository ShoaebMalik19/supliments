import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { FONT_DIR, renderLabelPng } from "./render";
import { loadLabelTemplate, type LabelTemplate } from "./template";

export const GOLDEN_TEMPLATE = join(
  process.cwd(),
  "db",
  "seed",
  "label-templates",
  "placeholder-60ct-bottle.json",
);

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Renders a fixed label (placeholder template, fixed text/colours, a solid synthetic logo) and
 * hashes the decoded pixels. The same numbers locally, in CI and on the deployed runtime prove
 * the renderer is host-independent.
 */
export async function goldenRender() {
  const template = loadLabelTemplate(
    JSON.parse(readFileSync(GOLDEN_TEMPLATE, "utf8")),
  ) as LabelTemplate;
  const logo = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 31, g: 111, b: 235 } },
  })
    .png()
    .toBuffer();
  const input = {
    template,
    design: {
      brandName: "Golden Labs",
      variantName: "Unflavored — Ünïcödé ✓",
      tagline: "Reference render",
      backgroundColor: "#FFFFFF",
      textColor: "#111111",
      logo: "golden",
    },
    images: { logo: new Uint8Array(logo) },
  };
  const hashes: Record<string, string> = {};
  for (const dpi of [72, template.printSpec.dpi]) {
    const png = await renderLabelPng(input, { dpi, includeBleed: dpi !== 72 });
    const raw = await sharp(png.data).raw().toBuffer();
    hashes[`pixels@${dpi}dpi`] = sha(raw);
  }
  const fonts = Object.fromEntries(
    ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].map((f) => [f, sha(readFileSync(join(FONT_DIR, f)))]),
  );
  return { hashes, fonts, sharp: { vips: sharp.versions.vips, sharp: sharp.versions.sharp } };
}
