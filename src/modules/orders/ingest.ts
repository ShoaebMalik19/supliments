import { and, asc, eq } from "drizzle-orm";
import { withTenant, type TenantDb } from "@/db/tenant";
import { customers, orderEvents, orderItems, orders, reviewQueueItems } from "@/db/schema";
import { chargeOrder, orderCharge, voidOrderCharge } from "@/modules/billing";
import { listBrands } from "@/modules/branding";
import { integrationForOrders } from "@/modules/integrations/orders";
import { HttpError } from "@/lib/http";
import {
  externalOrderSchema,
  type ExternalOrder,
  type IngestResult,
  type IngestTarget,
} from "./external";
import { resolveLines, type ExternalLine, type LineResolution } from "./lines";
import {
  CANCELLABLE_STATUSES,
  TERMINAL_STATUSES,
  transitionOrder,
  type OrderStatus,
} from "./state";

type Order = typeof orders.$inferSelect;
type Actor = { actorType: "integration" | "admin" | "system"; actorId: string | null };

export class InvalidExternalOrderError extends Error {}

const plain = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

/** Accepts the adapter's parsed ExternalOrder (bigints, Dates) or its wire form, and re-validates. */
function normalize(raw: unknown): ExternalOrder {
  const r = externalOrderSchema.safeParse(plain(raw));
  if (!r.success)
    throw new InvalidExternalOrderError(
      r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  return r.data;
}

/** One open review item per (type, order); tenants may insert only for their own org. */
async function openReviewItem(
  t: TenantDb,
  orderId: string,
  type: "failed_fulfillment" | "payment_hold",
) {
  await t.tx
    .insert(reviewQueueItems)
    .values({ orgId: t.orgId, type, entityType: "order", entityId: orderId, priority: 1 })
    .onConflictDoNothing();
}

async function findByExternalId(t: TenantDb, integrationId: string, externalOrderId: string) {
  const [row] = await t.tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.orgId, t.orgId),
        eq(orders.integrationId, integrationId),
        eq(orders.externalOrderId, externalOrderId),
      ),
    )
    .for("update");
  return row ?? null;
}

async function upsertCustomer(t: TenantDb, brandId: string, c: ExternalOrder["customer"]) {
  if (!c || (!c.externalId && !c.email)) return null;
  const match = c.externalId
    ? eq(customers.externalCustomerId, c.externalId)
    : eq(customers.email, c.email!);
  const [existing] = await t.tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.orgId, t.orgId), eq(customers.brandId, brandId), match))
    .limit(1);
  if (existing) return existing.id;
  const row = await t.insert(customers, {
    brandId,
    externalCustomerId: c.externalId,
    email: c.email,
    name: c.name,
    phone: c.phone,
  });
  return row.id;
}

async function insertItems(t: TenantDb, order: Order, res: LineResolution) {
  const base = (line: ExternalLine) => ({
    orderId: order.id,
    quantity: line.quantity,
    currency: order.currency,
    retailUnitPriceMinor: line.unitPriceMinor,
    externalLineItemId: line.externalLineItemId,
  });
  const rows = [
    ...res.resolved.map((r) => ({
      ...base(r.line),
      brandProductVariantId: r.variantId,
      skuId: r.skuId,
      labelId: r.labelId,
      costUnitMinor: r.unitCost.amountMinor,
      status: "pending" as const,
    })),
    ...res.unresolved.map((u) => ({
      ...base(u.line),
      brandProductVariantId: u.variantId,
      skuId: u.skuId,
      status: "needs_review" as const,
    })),
  ];
  return t.tx
    .insert(orderItems)
    .values(rows.map((r) => ({ ...r, orgId: t.orgId })))
    .returning();
}

/**
 * Moves a freshly resolved order on: unresolved lines or a pricing problem → needs_review with a
 * review item; otherwise one pending_external charge + ledger → awaiting_payment.
 */
async function settle(
  t: TenantDb,
  order: Order,
  res: LineResolution,
  items: (typeof orderItems.$inferSelect)[],
  actor: Actor,
): Promise<OrderStatus> {
  const toReview = async (holdReason: string, payload: Record<string, unknown>) => {
    if (order.status === "needs_review") {
      await t.update(orders, order.id, { holdReason });
      await t.insert(orderEvents, {
        orderId: order.id,
        type: "review_retried",
        ...actor,
        payload: { holdReason, ...payload },
      });
    } else {
      await transitionOrder(t, order.id, "needs_review", {
        type: "needs_review",
        ...actor,
        holdReason,
        payload,
      });
    }
    await openReviewItem(t, order.id, "failed_fulfillment");
    return "needs_review" as const;
  };

  if (res.unresolved.length > 0)
    return toReview("unresolved_lines", {
      unresolved: res.unresolved.map((u) => ({
        externalLineItemId: u.line.externalLineItemId,
        sku: u.line.sku,
        reason: u.reason,
      })),
    });

  const billable = items.filter((i) => i.status === "pending");
  const charged = await chargeOrder(t, {
    orderId: order.id,
    currency: order.currency,
    pricedAt: order.placedAt ?? order.importedAt,
    lines: billable.map((i) => ({
      itemId: i.id,
      quantity: i.quantity,
      unitCostMinor: i.costUnitMinor!,
    })),
  });
  if (!charged.ok) return toReview(charged.reason, {});
  for (const i of billable)
    await t.update(orderItems, i.id, { fulfillmentFeeMinor: charged.itemFees.get(i.id)! });
  await transitionOrder(t, order.id, "awaiting_payment", {
    type: "priced",
    ...actor,
    payload: {
      chargeId: charged.charge.id,
      feeScheduleId: charged.feeScheduleId,
      totalMinor: charged.price.totalMinor.toString(),
      currency: order.currency,
    },
  });
  return "awaiting_payment";
}

async function applyUpstreamChange(
  t: TenantDb,
  existing: Order,
  incoming: ExternalOrder,
  actor: Actor,
): Promise<IngestResult> {
  const unchanged = {
    outcome: "duplicate",
    orderId: existing.id,
    status: existing.status,
  } as const;
  if (!incoming.cancelled || TERMINAL_STATUSES.includes(existing.status)) return unchanged;
  if (CANCELLABLE_STATUSES.includes(existing.status)) {
    const charge = await voidOrderCharge(t, existing.id, "order_cancelled");
    await transitionOrder(t, existing.id, "cancelled", {
      type: "upstream_cancelled",
      ...actor,
      payload: { charge },
    });
    if (charge === "paid") await openReviewItem(t, existing.id, "payment_hold");
    return { outcome: "updated", orderId: existing.id, status: "cancelled" };
  }
  const [already] = await t.tx
    .select({ id: orderEvents.id })
    .from(orderEvents)
    .where(
      and(
        eq(orderEvents.orgId, t.orgId),
        eq(orderEvents.orderId, existing.id),
        eq(orderEvents.type, "upstream_cancel_requested"),
      ),
    )
    .limit(1);
  if (already) return unchanged;
  await t.insert(orderEvents, {
    orderId: existing.id,
    type: "upstream_cancel_requested",
    ...actor,
    payload: { status: existing.status },
  });
  await openReviewItem(t, existing.id, "failed_fulfillment");
  return { outcome: "updated", orderId: existing.id, status: existing.status };
}

/**
 * Idempotent on (integration, externalOrderId). Policy:
 * - test orders are ignored; an order is created only once it is `paid` (a pending order is
 *   ignored and the later paid event creates it); an unknown order arriving cancelled is ignored.
 * - an upstream cancel cancels ours while still before `submitted` (voiding an unpaid charge;
 *   a paid one gets a payment_hold review item), later it only flags a failed_fulfillment item.
 * - lines resolve per resolveLines; no line of ours → ignored `no_catalog_items`.
 */
export async function ingestExternalOrder(
  target: IngestTarget,
  raw: ExternalOrder,
): Promise<IngestResult> {
  const incoming = normalize(raw);
  if (incoming.test) return { outcome: "ignored", reason: "test_order" };
  const actor: Actor = { actorType: "integration", actorId: target.integrationId };
  return withTenant(target.orgId, async (t) => {
    const integration = await integrationForOrders(t, target.integrationId);
    if (!integration) throw new Error(`integration ${target.integrationId} not in org`);
    const existing = await findByExternalId(t, integration.id, incoming.externalOrderId);
    if (existing) return applyUpstreamChange(t, existing, incoming, actor);
    if (incoming.cancelled) return { outcome: "ignored", reason: "cancelled" };
    if (incoming.financialStatus !== "paid") return { outcome: "ignored", reason: "not_paid" };

    const brandId = integration.brandId ?? (await listBrands(t))[0]?.id;
    if (!brandId) throw new Error(`org ${t.orgId} has no brand`);
    const placedAt = incoming.placedAt ?? new Date();
    const res = await resolveLines(t, {
      integrationId: integration.id,
      brandId,
      currency: incoming.currency,
      at: placedAt,
      lines: incoming.lines,
    });
    if (res.resolved.length + res.unresolved.length === 0)
      return { outcome: "ignored", reason: "no_catalog_items" };

    const [order] = await t.tx
      .insert(orders)
      .values({
        orgId: t.orgId,
        brandId,
        integrationId: integration.id,
        externalOrderId: incoming.externalOrderId,
        externalOrderNumber: incoming.externalOrderNumber,
        shipTo: incoming.shipTo ?? {},
        billTo: incoming.billTo,
        currency: incoming.currency,
        retailSubtotalMinor: incoming.subtotalMinor,
        retailShippingMinor: incoming.shippingMinor,
        retailTotalMinor: incoming.totalMinor,
        placedAt,
      })
      .onConflictDoNothing({ target: [orders.integrationId, orders.externalOrderId] })
      .returning();
    if (!order) {
      const dup = await findByExternalId(t, integration.id, incoming.externalOrderId);
      return { outcome: "duplicate", orderId: dup!.id, status: dup!.status };
    }
    const customerId = await upsertCustomer(t, brandId, incoming.customer);
    if (customerId) await t.update(orders, order.id, { customerId });
    const items = await insertItems(t, order, res);
    await t.insert(orderEvents, {
      orderId: order.id,
      type: "order_received",
      toStatus: "received",
      ...actor,
      payload: {
        externalOrderId: incoming.externalOrderId,
        lines: plain(incoming.lines),
        skippedLineItemIds: res.skipped.map((l) => l.externalLineItemId),
      },
    });
    const status = await settle(t, order, res, items, actor);
    return { outcome: "created", orderId: order.id, status };
  });
}

/**
 * Re-runs line resolution and pricing for a `needs_review` order (after mappings, labels or fee
 * schedules were fixed) from the lines recorded at ingest. Returns the resulting status.
 */
export async function resolveOrder(t: TenantDb, actor: Actor, orderId: string) {
  const [order] = await t.tx
    .select()
    .from(orders)
    .where(and(eq(orders.orgId, t.orgId), eq(orders.id, orderId)))
    .for("update");
  if (!order) return null;
  if (order.status !== "needs_review") throw new HttpError(409, `order is ${order.status}`);
  const charge = await orderCharge(t, orderId);
  if (charge && charge.status !== "failed") {
    await transitionOrder(t, orderId, "awaiting_payment", { type: "review_resolved", ...actor });
    return "awaiting_payment" as const;
  }
  const [received] = await t.tx
    .select()
    .from(orderEvents)
    .where(
      and(
        eq(orderEvents.orgId, t.orgId),
        eq(orderEvents.orderId, orderId),
        eq(orderEvents.type, "order_received"),
      ),
    )
    .orderBy(asc(orderEvents.createdAt))
    .limit(1);
  if (!order.integrationId || !received)
    throw new HttpError(409, "order has no recorded external lines");
  const lines = (received.payload as { lines: unknown }).lines;
  const parsed = externalOrderSchema.shape.lines.parse(lines);
  const res = await resolveLines(t, {
    integrationId: order.integrationId,
    brandId: order.brandId,
    currency: order.currency,
    at: order.placedAt ?? order.importedAt,
    lines: parsed,
  });
  if (res.resolved.length + res.unresolved.length === 0) {
    await t.insert(orderEvents, {
      orderId,
      type: "review_retried",
      ...actor,
      payload: { holdReason: "no_catalog_items" },
    });
    return "needs_review" as const;
  }
  await t.tx
    .delete(orderItems)
    .where(and(eq(orderItems.orgId, t.orgId), eq(orderItems.orderId, orderId)));
  return settle(t, order, res, await insertItems(t, order, res), actor);
}
