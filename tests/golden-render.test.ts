import { describe, expect, it } from "vitest";
import { goldenRender } from "@/modules/labels/golden";

/**
 * Pixel hashes of the reference label. The deployed runtime reports the same numbers at
 * GET /api/admin/diagnostics/render; any drift (font, sharp/libvips, renderer) fails here first.
 */
export const GOLDEN = {
  "pixels@72dpi": "f7e4267ade038638903db71643d323845ba618840a890005db97c01c2a5f19d5",
  "pixels@300dpi": "9d4d18f322da405a7745328b041fe0d462befe9c45b792e5b09e6626ddb934fd",
};

describe("host-independent label rendering", () => {
  it("renders the reference label pixel-identically", async () => {
    const r = await goldenRender();
    expect(r.hashes).toEqual(GOLDEN);
    expect(r.fonts["DejaVuSans.ttf"]).toBe(
      "ae7b7855e115a5966d8b1b3f80f254ccc117ec86f9965e202ee2940453837280",
    );
  });
});
