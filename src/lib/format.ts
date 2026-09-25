export function formatMinor(amountMinor: bigint, currency: string) {
  const neg = amountMinor < 0n;
  const abs = neg ? -amountMinor : amountMinor;
  const units = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${units}.${cents} ${currency}`;
}
