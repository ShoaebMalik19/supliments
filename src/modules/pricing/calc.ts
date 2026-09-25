import { z } from "zod";

const minor = z.union([z.int().nonnegative(), z.string().regex(/^\d{1,18}$/)]).transform(BigInt);

/** Stored in `fee_schedules.rules`. All amounts in the schedule's currency. */
export const feeRulesSchema = z.strictObject({
  perOrderFulfillmentFeeMinor: minor,
  perUnitFulfillmentFeeMinor: minor,
  shipping: z.strictObject({ firstUnitMinor: minor, additionalUnitMinor: minor }),
  platformMarkupBps: z.int().min(0).max(10_000),
});

export type FeeRules = z.output<typeof feeRulesSchema>;

export class CurrencyMismatchError extends Error {}

export function assertSameCurrency(...codes: string[]) {
  if (new Set(codes).size > 1)
    throw new CurrencyMismatchError(`currency mismatch: ${codes.join("/")}`);
}

/** Basis points of a non-negative amount, rounded half-up to the minor unit. */
export function applyBps(amount: bigint, bps: number): bigint {
  if (amount < 0n) throw new Error("applyBps expects a non-negative amount");
  return (amount * BigInt(bps) + 5_000n) / 10_000n;
}

export type OrderLineCost = { quantity: number; unitCostMinor: bigint };

export type OrderPrice = {
  cogsMinor: bigint;
  fulfillmentFeeMinor: bigint;
  shippingMinor: bigint;
  platformMarkupMinor: bigint;
  totalMinor: bigint;
};

/** What the brand owes us for one order. Pure; every figure is integer minor units. */
export function priceOrder(lines: OrderLineCost[], rules: FeeRules): OrderPrice {
  const units = lines.reduce((n, l) => {
    if (!Number.isSafeInteger(l.quantity) || l.quantity <= 0) throw new Error("invalid quantity");
    return n + l.quantity;
  }, 0);
  if (units === 0) throw new Error("order has no billable units");
  const q = BigInt(units);
  const cogsMinor = lines.reduce((s, l) => s + l.unitCostMinor * BigInt(l.quantity), 0n);
  const fulfillmentFeeMinor =
    rules.perOrderFulfillmentFeeMinor + rules.perUnitFulfillmentFeeMinor * q;
  const shippingMinor =
    rules.shipping.firstUnitMinor + rules.shipping.additionalUnitMinor * (q - 1n);
  const platformMarkupMinor = applyBps(cogsMinor, rules.platformMarkupBps);
  return {
    cogsMinor,
    fulfillmentFeeMinor,
    shippingMinor,
    platformMarkupMinor,
    totalMinor: cogsMinor + fulfillmentFeeMinor + shippingMinor + platformMarkupMinor,
  };
}

/**
 * Margin for a brand selling one unit: retail minus our cost of a single-unit order
 * (cogs + fees + shipping + markup). Negative margins are reported, not rejected.
 */
export function unitEconomics(input: {
  retailPriceMinor: bigint;
  unitCostMinor: bigint;
  rules: FeeRules;
}) {
  const cost = priceOrder([{ quantity: 1, unitCostMinor: input.unitCostMinor }], input.rules);
  const marginMinor = input.retailPriceMinor - cost.totalMinor;
  const marginBps =
    input.retailPriceMinor > 0n ? Number((marginMinor * 10_000n) / input.retailPriceMinor) : null;
  return { retailPriceMinor: input.retailPriceMinor, cost, marginMinor, marginBps };
}
