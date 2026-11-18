import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { TenantDb } from "@/db/tenant";
import { customers, orderItems, orders, skus } from "@/db/schema";
import type { OrderStatus } from "./state";

/** Whose data a privacy request covers, within one store integration of the caller's org. */
export type PrivacySubject =
  | {
      integrationId: string;
      externalCustomerId: string | null;
      email: string | null;
      externalOrderIds: string[];
    }
  | { integrationId: string; wholeStore: true };

/**
 * Orders that still need the address to be shipped. Redacting them would strand a paid order, so
 * their addresses are kept until they ship (or end) and the redaction is retried.
 */
const ADDRESS_STILL_NEEDED: readonly OrderStatus[] = [
  "received",
  "needs_review",
  "on_hold",
  "awaiting_payment",
  "submitted",
  "accepted",
  "in_production",
  "packed",
];

export const REDACTED = { redacted: true } as const;

const redactedAddress = (a: unknown) => {
  const country = (a as { countryCode?: unknown } | null)?.countryCode;
  return { ...REDACTED, countryCode: typeof country === "string" ? country : null };
};

const isRedacted = (a: unknown) => (a as { redacted?: unknown } | null)?.redacted === true;

async function subjectCustomerIds(t: TenantDb, s: PrivacySubject) {
  const byIntegration = t.tx
    .selectDistinct({ id: orders.customerId })
    .from(orders)
    .where(and(eq(orders.orgId, t.orgId), eq(orders.integrationId, s.integrationId)));
  if ("wholeStore" in s) {
    const rows = await byIntegration;
    return rows.map((r) => r.id).filter((id): id is string => !!id);
  }
  const match = [
    s.externalCustomerId ? eq(customers.externalCustomerId, s.externalCustomerId) : undefined,
    s.email ? sql`lower(${customers.email}) = lower(${s.email})` : undefined,
  ].filter(Boolean);
  if (!match.length) return [];
  const rows = await t.tx
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.orgId, t.orgId),
        or(...match),
        inArray(customers.id, sql`(${byIntegration})`),
      ),
    );
  return rows.map((r) => r.id);
}

async function subjectOrders(t: TenantDb, s: PrivacySubject, customerIds: string[]) {
  const scope = and(eq(orders.orgId, t.orgId), eq(orders.integrationId, s.integrationId));
  if ("wholeStore" in s) return t.tx.select().from(orders).where(scope);
  const who = [
    s.externalOrderIds.length ? inArray(orders.externalOrderId, s.externalOrderIds) : undefined,
    customerIds.length ? inArray(orders.customerId, customerIds) : undefined,
  ].filter(Boolean);
  if (!who.length) return [];
  return t.tx
    .select()
    .from(orders)
    .where(and(scope, or(...who)));
}

/** Everything we hold about the subject, for the merchant to hand to the customer. */
export async function exportCustomerData(t: TenantDb, s: PrivacySubject) {
  const customerIds = await subjectCustomerIds(t, s);
  const found = await subjectOrders(t, s, customerIds);
  const people = customerIds.length
    ? await t.tx.select().from(customers).where(inArray(customers.id, customerIds))
    : [];
  const items = found.length
    ? await t.tx
        .select({
          orderId: orderItems.orderId,
          sku: skus.sku,
          quantity: orderItems.quantity,
          unitPriceMinor: orderItems.retailUnitPriceMinor,
          currency: orderItems.currency,
        })
        .from(orderItems)
        .leftJoin(skus, eq(skus.id, orderItems.skuId))
        .where(
          inArray(
            orderItems.orderId,
            found.map((o) => o.id),
          ),
        )
    : [];
  return {
    customers: people.map((c) => ({
      externalCustomerId: c.externalCustomerId,
      name: c.name,
      email: c.email,
      phone: c.phone,
      firstSeenAt: c.createdAt,
    })),
    orders: found.map((o) => ({
      externalOrderId: o.externalOrderId,
      orderNumber: o.externalOrderNumber,
      placedAt: o.placedAt,
      status: o.status,
      currency: o.currency,
      totalMinor: o.retailTotalMinor.toString(),
      shipTo: o.shipTo,
      billTo: o.billTo,
      items: items
        .filter((i) => i.orderId === o.id)
        .map((i) => ({
          sku: i.sku,
          quantity: i.quantity,
          unitPriceMinor: i.unitPriceMinor?.toString() ?? null,
          currency: i.currency,
        })),
    })),
  };
}

/**
 * Removes the subject's personal data: customer contact fields and order addresses. Orders still
 * on their way keep their address and come back as `deferredOrderIds` for a later retry.
 * Idempotent: already-redacted rows are left alone and counted as done.
 */
export async function redactCustomerData(t: TenantDb, s: PrivacySubject) {
  const customerIds = await subjectCustomerIds(t, s);
  const found = await subjectOrders(t, s, customerIds);
  const deferred = found.filter((o) => ADDRESS_STILL_NEEDED.includes(o.status));
  const redactable = found.filter((o) => !ADDRESS_STILL_NEEDED.includes(o.status));
  for (const o of redactable) {
    if (isRedacted(o.shipTo) && (o.billTo === null || isRedacted(o.billTo))) continue;
    await t.update(orders, o.id, {
      shipTo: redactedAddress(o.shipTo),
      billTo: o.billTo === null ? null : redactedAddress(o.billTo),
    });
  }
  const pendingCustomers = new Set(deferred.map((o) => o.customerId).filter(Boolean));
  const clearable = customerIds.filter((id) => !pendingCustomers.has(id));
  if (clearable.length)
    await t.tx
      .update(customers)
      .set({ email: null, phone: null, name: null })
      .where(and(eq(customers.orgId, t.orgId), inArray(customers.id, clearable)));
  return {
    customersRedacted: clearable.length,
    redactedOrderIds: redactable.map((o) => o.id),
    redactedExternalOrderIds: redactable
      .map((o) => o.externalOrderId)
      .filter((x): x is string => !!x),
    deferredOrderIds: deferred.map((o) => o.id),
  };
}
