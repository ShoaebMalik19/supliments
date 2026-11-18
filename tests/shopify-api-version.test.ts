import { describe, expect, it } from "vitest";
import { SHOPIFY_API_VERSION } from "@/adapters/shopify";

/**
 * Shopify supports each quarterly Admin API version for 12 months, then silently serves the oldest
 * supported one instead: behaviour changes under you with no error. 2025-07 had already aged out
 * when the app first met a real store. Fail 3 months before that happens.
 */
describe("Shopify Admin API version", () => {
  it("is a real quarterly release and has at least 3 months of support left", () => {
    const m = /^(\d{4})-(01|04|07|10)$/.exec(SHOPIFY_API_VERSION);
    expect(m, "format YYYY-01|04|07|10").not.toBeNull();
    const released = Date.UTC(Number(m![1]), Number(m![2]) - 1, 1);
    const supportEnds = Date.UTC(Number(m![1]) + 1, Number(m![2]) - 1, 1);
    expect(released).toBeLessThanOrEqual(Date.now());
    expect(supportEnds - Date.now(), "bump SHOPIFY_API_VERSION").toBeGreaterThan(
      90 * 24 * 3600_000,
    );
  });
});
