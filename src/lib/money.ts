import { z } from "zod";

export type Money = { amountMinor: bigint; currency: string };

const ISO = /^[A-Z]{3}$/;

export function money(amountMinor: bigint, currency: string): Money {
  if (!ISO.test(currency)) throw new Error(`invalid currency ${currency}`);
  return { amountMinor, currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`currency mismatch ${a.currency}/${b.currency}`);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

/**
 * Wire format for minor units: a JSON safe integer, or a string of digits (what `json()` emits
 * for bigint). Decimals ("12.50", 12.5), exponents and anything else are rejected.
 */
export const minorUnitsInput = z
  .union([z.int(), z.string().regex(/^-?\d{1,18}$/)])
  .transform((v) => BigInt(v));

export const nonNegativeMinorInput = minorUnitsInput.refine((v) => v >= 0n, "must be >= 0");

export const currencyInput = z.string().regex(ISO, "ISO-4217 uppercase code");
