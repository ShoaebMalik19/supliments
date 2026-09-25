import { and, asc, desc, eq } from "drizzle-orm";
import type { TenantDb } from "@/db/tenant";
import { orderEvents, orderItems, orders } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { markChargePaid, orderBilling, orderCharge, paidOrderIds } from "@/modules/billing";
import { enqueue } from "@/modules/jobs";
import { HttpError } from "@/lib/http";

export * from "./external";
export * from "./state";
export { ingestExternalOrder, resolveOrder, InvalidExternalOrderError } from "./ingest";

export const ORDER_PAID_JOB = "fulfillment.order_paid";

export async function listOrders(t: TenantDb) {
  return t.tx
    .select({
      id: orders.id,
      externalOrderNumber: orders.externalOrderNumber,
      status: orders.status,
      holdReason: orders.holdReason,
      currency: orders.currency,
      retailTotalMinor: orders.retailTotalMinor,
      placedAt: orders.placedAt,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(eq(orders.orgId, t.orgId))
    .orderBy(desc(orders.createdAt))
    .limit(200);
}

/** Order with items, its charge and ledger summary, and the event timeline (oldest first). */
export async function getOrder(t: TenantDb, id: string) {
  const order = await t.find(orders, id);
  if (!order) return null;
  const items = await t.tx
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.orgId, t.orgId), eq(orderItems.orderId, id)))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  const timeline = await t.tx
    .select()
    .from(orderEvents)
    .where(and(eq(orderEvents.orgId, t.orgId), eq(orderEvents.orderId, id)))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
  const billing = await orderBilling(t, id);
  return { order, items, charge: billing.charge, ledger: billing.summary, timeline };
}

/**
 * Orders whose charge is paid but that fulfillment has not submitted yet. The order stays
 * `awaiting_payment` after payment: fulfillment moves it to `submitted` (transitionOrder).
 */
export async function paidOrdersAwaitingSubmission(t: TenantDb) {
  const waiting = await t.tx
    .select()
    .from(orders)
    .where(and(eq(orders.orgId, t.orgId), eq(orders.status, "awaiting_payment")))
    .orderBy(asc(orders.createdAt));
  const paid = await paidOrderIds(
    t,
    waiting.map((o) => o.id),
  );
  return waiting.filter((o) => paid.has(o.id));
}

/**
 * Ops-marked payment for an `awaiting_payment` order: charge succeeded + payment ledger line,
 * `payment_recorded` event, audit row and a `fulfillment.order_paid` job, all in one transaction.
 * Marking an already-paid order again changes nothing (`alreadyPaid: true`).
 */
export async function recordOrderPayment(
  t: TenantDb,
  admin: { userId: string },
  orderId: string,
  input: { reference: string; note: string | null },
) {
  const [order] = await t.tx
    .select()
    .from(orders)
    .where(and(eq(orders.orgId, t.orgId), eq(orders.id, orderId)))
    .for("update");
  if (!order) return null;
  const charge = await orderCharge(t, orderId);
  if (!charge) throw new HttpError(409, "order has no charge");
  if (charge.status === "succeeded") return { alreadyPaid: true, order, charge };
  if (order.status !== "awaiting_payment") throw new HttpError(409, `order is ${order.status}`);
  const paid = await markChargePaid(t, admin, charge.id, input);
  if (!paid) return null;
  await t.insert(orderEvents, {
    orderId,
    type: "payment_recorded",
    actorType: "admin",
    actorId: admin.userId,
    payload: {
      chargeId: charge.id,
      amountMinor: charge.amountMinor.toString(),
      currency: charge.currency,
      reference: input.reference,
      note: input.note,
    },
  });
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: admin.userId,
      actorType: "admin",
      action: "admin.order_payment_recorded",
      entityType: "charge",
      entityId: charge.id,
      before: { status: charge.status },
      after: { status: paid.charge.status, reference: input.reference, orderId },
    },
    t.tx,
  );
  await enqueue(t, {
    kind: ORDER_PAID_JOB,
    payload: { orderId },
    dedupeKey: `${ORDER_PAID_JOB}:${orderId}`,
  });
  return { alreadyPaid: paid.alreadyPaid, order, charge: paid.charge };
}
