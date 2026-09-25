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
