import { and, asc, eq, inArray } from "drizzle-orm";
import type { TenantDb } from "@/db/tenant";
import { charges, ledgerEntries, ledgerAccount } from "@/db/schema";
import { feeScheduleAt, priceOrder, type FeeRules, type OrderPrice } from "@/modules/pricing";
import { HttpError } from "@/lib/http";
import { paymentProvider } from "./payment";

export * from "./payment";

export type LedgerAccount = (typeof ledgerAccount.enumValues)[number];
export type ChargeableLine = { itemId: string; quantity: number; unitCostMinor: bigint };

export type OrderChargeResult =
  | {
      ok: true;
      charge: typeof charges.$inferSelect;
      price: OrderPrice;
      feeScheduleId: string;
      /** Fulfillment fee allocated to each order item (line total, sums to the order's fee). */
      itemFees: Map<string, bigint>;
    }
  | { ok: false; reason: "no_fee_schedule" | "currency_mismatch" | "already_charged" };

export const orderChargeKey = (orderId: string) => `order:${orderId}`;

/**
 * Per-line fulfillment fee: the per-unit fee times quantity, plus the per-order fee split by
 * units (largest remainder, earlier lines first) so the lines sum exactly to the order fee.
 */
export function allocateFulfillmentFee(rules: FeeRules, lines: ChargeableLine[]) {
  const units = lines.reduce((n, l) => n + BigInt(l.quantity), 0n);
  const shares = lines.map((l) => (rules.perOrderFulfillmentFeeMinor * BigInt(l.quantity)) / units);
  let remainder = rules.perOrderFulfillmentFeeMinor - shares.reduce((a, b) => a + b, 0n);
  const order = lines
    .map((l, i) => ({ i, rem: (rules.perOrderFulfillmentFeeMinor * BigInt(l.quantity)) % units }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of order) {
    if (remainder === 0n) break;
    shares[i]! += 1n;
    remainder -= 1n;
  }
  return new Map(
    lines.map((l, i) => [
      l.itemId,
      rules.perUnitFulfillmentFeeMinor * BigInt(l.quantity) + shares[i]!,
    ]),
  );
}

/**
 * Prices an order from the fee schedule in force at `pricedAt` (falling back to the one in force
 * now) and writes one `pending_external` charge plus its cost ledger lines. Amounts are frozen:
 * later fee schedule versions never touch an existing charge.
 */
export async function chargeOrder(
  t: TenantDb,
  input: { orderId: string; currency: string; pricedAt: Date; lines: ChargeableLine[] },
): Promise<OrderChargeResult> {
  const schedule = (await feeScheduleAt(t, input.pricedAt)) ?? (await feeScheduleAt(t));
  if (!schedule) return { ok: false, reason: "no_fee_schedule" };
  if (schedule.currency !== input.currency) return { ok: false, reason: "currency_mismatch" };
  const price = priceOrder(input.lines, schedule.rules);
  const [charge] = await t.tx
    .insert(charges)
    .values({
      orgId: t.orgId,
      orderId: input.orderId,
      kind: "order",
      amountMinor: price.totalMinor,
      currency: input.currency,
      provider: "manual",
      status: "pending_external",
      feeScheduleId: schedule.id,
      idempotencyKey: orderChargeKey(input.orderId),
    })
    .onConflictDoNothing({ target: charges.idempotencyKey })
    .returning();
  if (!charge) return { ok: false, reason: "already_charged" };
  const entries: [LedgerAccount, bigint][] = [
    ["cogs", price.cogsMinor],
    ["fulfillment_fee", price.fulfillmentFeeMinor],
    ["shipping", price.shippingMinor],
    ["platform_markup", price.platformMarkupMinor],
  ];
  await t.tx.insert(ledgerEntries).values(
    entries.map(([account, amountMinor]) => ({
      orgId: t.orgId,
      orderId: input.orderId,
      chargeId: charge.id,
      feeScheduleId: schedule.id,
      account,
      amountMinor,
      currency: input.currency,
      memo: `fee schedule v${schedule.version}`,
    })),
  );
  return {
    ok: true,
    charge,
    price,
    feeScheduleId: schedule.id,
    itemFees: allocateFulfillmentFee(schedule.rules, input.lines),
  };
}

export async function orderCharge(t: TenantDb, orderId: string) {
  const [charge] = await t.tx
    .select()
    .from(charges)
    .where(and(eq(charges.orgId, t.orgId), eq(charges.idempotencyKey, orderChargeKey(orderId))));
  return charge ?? null;
}

/** The order's charge, ledger lines and per-account totals. balance = what is still owed. */
export async function orderBilling(t: TenantDb, orderId: string) {
  const charge = await orderCharge(t, orderId);
  const ledger = await t.tx
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.orgId, t.orgId), eq(ledgerEntries.orderId, orderId)))
    .orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.id));
  const byAccount: Partial<Record<LedgerAccount, bigint>> = {};
  for (const e of ledger) byAccount[e.account] = (byAccount[e.account] ?? 0n) + e.amountMinor;
  const balanceMinor = ledger.reduce((s, e) => s + e.amountMinor, 0n);
  return {
    charge,
    ledger,
    summary: { byAccount, balanceMinor, currency: charge?.currency ?? null },
  };
}

export class ChargeNotPayableError extends HttpError {
  constructor(status: string) {
    super(409, `charge is ${status}`);
  }
}

/**
 * Records an ops-confirmed payment through the charge's PaymentProvider: charge → succeeded,
 * marked_paid_by/at, and a negative `payment` ledger line that zeroes the order balance.
 * Idempotent: an already-succeeded charge is returned untouched with `alreadyPaid: true`.
 */
export async function markChargePaid(
  t: TenantDb,
  actor: { userId: string },
  chargeId: string,
  input: { reference: string; note: string | null },
) {
  const [locked] = await t.tx
    .select()
    .from(charges)
    .where(and(eq(charges.id, chargeId), eq(charges.orgId, t.orgId)))
    .for("update");
  if (!locked) return null;
  if (locked.status === "succeeded") return { charge: locked, alreadyPaid: true as const };
  if (!["pending_external", "pending", "requires_action"].includes(locked.status))
    throw new ChargeNotPayableError(locked.status);
  const recorded = await paymentProvider(locked.provider).recordPayment({
    chargeId,
    amount: { amountMinor: locked.amountMinor, currency: locked.currency },
    reference: input.reference,
    note: input.note,
    recordedBy: actor.userId,
  });
  const charge = await t.update(charges, chargeId, {
    status: recorded.status,
    providerPaymentIntentId: recorded.providerPaymentId,
    markedPaidBy: actor.userId,
    markedPaidAt: new Date(),
    attempts: locked.attempts + 1,
  });
  await t.tx.insert(ledgerEntries).values({
    orgId: t.orgId,
    orderId: locked.orderId,
    chargeId,
    feeScheduleId: locked.feeScheduleId,
    account: "payment",
    amountMinor: -locked.amountMinor,
    currency: locked.currency,
    memo: `payment ${input.reference}`,
  });
  return { charge: charge!, alreadyPaid: false as const };
}

/**
 * For an order cancelled before payment: the pending charge becomes `failed` (with the reason as
 * failure code) and an `adjustment` line reverses the outstanding balance. A paid charge is left
 * alone and reported, since returning money is a human decision.
 */
export async function voidOrderCharge(
  t: TenantDb,
  orderId: string,
  reason: string,
): Promise<"none" | "voided" | "paid"> {
  const [locked] = await t.tx
    .select()
    .from(charges)
    .where(and(eq(charges.orgId, t.orgId), eq(charges.idempotencyKey, orderChargeKey(orderId))))
    .for("update");
  if (!locked) return "none";
  if (locked.status === "succeeded") return "paid";
  if (!["pending_external", "pending", "requires_action"].includes(locked.status)) return "none";
  await t.update(charges, locked.id, { status: "failed", failureCode: reason });
  const { summary } = await orderBilling(t, orderId);
  if (summary.balanceMinor !== 0n)
    await t.tx.insert(ledgerEntries).values({
      orgId: t.orgId,
      orderId,
      chargeId: locked.id,
      feeScheduleId: locked.feeScheduleId,
      account: "adjustment",
      amountMinor: -summary.balanceMinor,
      currency: locked.currency,
      memo: reason,
    });
  return "voided";
}

/** Order ids among `orderIds` whose order charge has succeeded. */
export async function paidOrderIds(t: TenantDb, orderIds: string[]) {
  if (orderIds.length === 0) return new Set<string>();
  const rows = await t.tx
    .select({ orderId: charges.orderId })
    .from(charges)
    .where(
      and(
        eq(charges.orgId, t.orgId),
        eq(charges.kind, "order"),
        eq(charges.status, "succeeded"),
        inArray(charges.orderId, orderIds),
      ),
    );
  return new Set(rows.map((r) => r.orderId!));
}
