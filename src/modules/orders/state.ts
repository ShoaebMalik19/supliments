import { and, eq } from "drizzle-orm";
import type { TenantDb } from "@/db/tenant";
import { orderEvents, orders, orderStatus, outboxEvents } from "@/db/schema";

export type OrderStatus = (typeof orderStatus.enumValues)[number];
export type OrderActorType = "user" | "admin" | "system" | "integration";

/**
 * Order lifecycle (§4.1, §0.1). Key path:
 * received → awaiting_payment → submitted → accepted → in_production → packed → shipped
 * → in_transit → delivered. Fulfillment steps may be skipped forward (a partner sheet can
 * report `shipped` straight after `submitted`), never backward.
 *
 * - Pre-submission states (received, needs_review, on_hold, awaiting_payment) can move between
 *   each other, be cancelled, or fail. Cancellation is only possible before `submitted`: after
 *   that the manufacturer has the order and stopping it is an ops decision (failed/refunded).
 * - `awaiting_payment` exits only to `submitted` (fulfillment moves it once the charge is paid).
 * - `refunded` ends an order already handed to fulfillment; `returned` is return-to-sender in
 *   transit. Terminal: delivered, returned, cancelled, refunded, failed.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  received: ["awaiting_payment", "needs_review", "on_hold", "cancelled", "failed"],
  needs_review: ["received", "awaiting_payment", "on_hold", "cancelled", "failed"],
  on_hold: ["received", "needs_review", "awaiting_payment", "cancelled", "failed"],
  awaiting_payment: ["submitted", "needs_review", "on_hold", "cancelled", "failed"],
  submitted: ["accepted", "in_production", "packed", "shipped", "refunded", "failed"],
  accepted: ["in_production", "packed", "shipped", "refunded", "failed"],
  in_production: ["packed", "shipped", "refunded", "failed"],
  packed: ["shipped", "refunded", "failed"],
  shipped: ["in_transit", "delivered", "returned", "refunded"],
  in_transit: ["delivered", "returned", "refunded"],
  delivered: [],
  returned: [],
  cancelled: [],
  refunded: [],
  failed: [],
};

export const TERMINAL_STATUSES: readonly OrderStatus[] = (
  Object.keys(ORDER_TRANSITIONS) as OrderStatus[]
).filter((s) => ORDER_TRANSITIONS[s].length === 0);

export const CANCELLABLE_STATUSES: readonly OrderStatus[] = (
  Object.keys(ORDER_TRANSITIONS) as OrderStatus[]
).filter((s) => ORDER_TRANSITIONS[s].includes("cancelled"));

export function canTransition(from: OrderStatus, to: OrderStatus) {
  return ORDER_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly orderId: string,
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`illegal order transition ${from} → ${to} (${orderId})`);
  }
}

export type TransitionMeta = {
  type: string;
  actorType: OrderActorType;
  actorId?: string | null;
  payload?: Record<string, unknown>;
  holdReason?: string | null;
};

/**
 * Locks the order, validates the move against ORDER_TRANSITIONS, updates the status, appends an
 * order_event and an `order.status_changed` outbox event, all in the caller's transaction.
 * Returns null when the order is not visible to this tenant.
 */
export async function transitionOrder(
  t: TenantDb,
  orderId: string,
  to: OrderStatus,
  meta: TransitionMeta,
) {
  const [current] = await t.tx
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.orgId, t.orgId)))
    .for("update");
  if (!current) return null;
  const from = current.status;
  if (!canTransition(from, to)) throw new IllegalTransitionError(orderId, from, to);
  const holdReason =
    meta.holdReason !== undefined
      ? meta.holdReason
      : to === "needs_review" || to === "on_hold"
        ? undefined
        : null;
  const updated = await t.update(orders, orderId, {
    status: to,
    ...(holdReason !== undefined && { holdReason }),
  });
  await t.insert(orderEvents, {
    orderId,
    type: meta.type,
    fromStatus: from,
    toStatus: to,
    actorType: meta.actorType,
    actorId: meta.actorId ?? null,
    payload: meta.payload ?? {},
  });
  await t.tx.insert(outboxEvents).values({
    orgId: t.orgId,
    aggregateType: "order",
    aggregateId: orderId,
    eventType: "order.status_changed",
    payload: { orderId, from, to, type: meta.type },
  });
  return updated!;
}
