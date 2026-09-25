import { describe, expect, it } from "vitest";
import { applyBps, feeRulesSchema, priceOrder, unitEconomics } from "@/modules/pricing/calc";

const raw = {
  perOrderFulfillmentFeeMinor: 250,
  perUnitFulfillmentFeeMinor: 75,
  shipping: { firstUnitMinor: 499, additionalUnitMinor: 99 },
  platformMarkupBps: 1500,
};
const rules = feeRulesSchema.parse(raw);

describe("money maths", () => {
  it("rounds basis points half-up in integer minor units", () => {
    expect(applyBps(1000n, 1500)).toBe(150n);
    expect(applyBps(3n, 5000)).toBe(2n);
    expect(applyBps(1n, 4999)).toBe(0n);
    expect(applyBps(1n, 5000)).toBe(1n);
    expect(() => applyBps(-1n, 100)).toThrow();
  });

  it("prices a multi-line order exactly", () => {
    const p = priceOrder(
      [
        { quantity: 2, unitCostMinor: 850n },
        { quantity: 1, unitCostMinor: 1233n },
      ],
      rules,
    );
    expect(p).toEqual({
      cogsMinor: 2933n,
      fulfillmentFeeMinor: 250n + 3n * 75n,
      shippingMinor: 499n + 2n * 99n,
      platformMarkupMinor: 440n,
      totalMinor: 2933n + 475n + 697n + 440n,
    });
  });

  it("the components always sum to the total", () => {
    for (let q = 1; q <= 20; q++) {
      const p = priceOrder([{ quantity: q, unitCostMinor: BigInt(q * 137) }], rules);
      expect(p.cogsMinor + p.fulfillmentFeeMinor + p.shippingMinor + p.platformMarkupMinor).toBe(
        p.totalMinor,
      );
    }
  });

  it("rejects empty orders and non-integer quantities", () => {
    expect(() => priceOrder([], rules)).toThrow();
    expect(() => priceOrder([{ quantity: 1.5, unitCostMinor: 1n }], rules)).toThrow();
    expect(() => priceOrder([{ quantity: 0, unitCostMinor: 1n }], rules)).toThrow();
  });

  it("computes unit margin including single-order fees, and reports negatives", () => {
    const e = unitEconomics({ retailPriceMinor: 2999n, unitCostMinor: 850n, rules });
    expect(e.cost.totalMinor).toBe(850n + 325n + 499n + 128n);
    expect(e.marginMinor).toBe(2999n - 1802n);
    expect(e.marginBps).toBe(3991);
    expect(
      unitEconomics({ retailPriceMinor: 1000n, unitCostMinor: 850n, rules }).marginMinor,
    ).toBeLessThan(0n);
  });

  it("fee rules reject decimals and floats", () => {
    expect(feeRulesSchema.parse(raw)).toEqual(rules);
    expect(() => feeRulesSchema.parse({ ...raw, perOrderFulfillmentFeeMinor: 2.5 })).toThrow();
    expect(() => feeRulesSchema.parse({ ...raw, perOrderFulfillmentFeeMinor: "2.50" })).toThrow();
  });
});
