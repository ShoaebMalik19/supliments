/**
 * Shopify sends and accepts money as decimal strings ("12.34") in the shop currency.
 * These convert to/from integer minor units by string manipulation only — never floats.
 * Assumes a 2-decimal currency; zero- and three-decimal currencies are out of scope (v1).
 */
export const MINOR_DIGITS = 2;

const DECIMAL = /^(\d{1,16})(?:\.(\d+))?$/;

export function decimalToMinor(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "number" ? (Number.isInteger(value) ? String(value) : "") : value;
  const m = DECIMAL.exec(s.trim());
  if (!m) return null;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > MINOR_DIGITS) return null;
  return BigInt(m[1]! + frac.padEnd(MINOR_DIGITS, "0"));
}

export function minorToDecimal(minor: bigint): string {
  if (minor < 0n) throw new Error("negative amounts are not published");
  const s = minor.toString().padStart(MINOR_DIGITS + 1, "0");
  return `${s.slice(0, -MINOR_DIGITS)}.${s.slice(-MINOR_DIGITS)}`;
}
