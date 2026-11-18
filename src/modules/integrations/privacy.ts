import { withTenant } from "@/db/tenant";
import { outboxEvents, reviewQueueItems } from "@/db/schema";
import { storeGeneratedAsset } from "@/modules/assets";
import { recordAudit } from "@/modules/audit";
import { redactFulfillmentSnapshots } from "@/modules/fulfillment";
import { enqueue, kickQueue } from "@/modules/jobs";
import { exportCustomerData, redactCustomerData, type PrivacySubject } from "@/modules/orders";
import type { PrivacyRequest } from "./provider";
import { redactWebhookEvent, redactWebhookPayloads } from "./privileged";

export const JOB_PRIVACY_RETRY = "integrations.privacy_retry";
/** Shopify expects privacy requests completed within 30 days of receipt. */
export const PRIVACY_DEADLINE_DAYS = 30;
export const PRIVACY_RETRY_HOURS = 24;
/** After this long with orders still in flight, a human decides (escalate before the deadline). */
export const PRIVACY_ESCALATE_DAYS = 21;

const DAY = 86_400_000;

export type PrivacyOutcome =
  | { status: "completed"; summary: Record<string, number> }
  | { status: "deferred"; summary: Record<string, number>; deferredOrders: number };

function subject(integrationId: string, req: PrivacyRequest): PrivacySubject {
  if (req.type === "shop_redact") return { integrationId, wholeStore: true };
  return {
    integrationId,
    externalCustomerId: req.customer.externalId,
    email: req.customer.email,
    externalOrderIds: req.externalOrderIds,
  };
}

/**
 * Carries out one privacy request for one store integration. Data requests produce an export the
 * brand owner downloads; redactions remove personal data except from orders still being shipped,
 * which are retried daily and escalated to a human before the 30-day deadline. Audit rows carry
 * counts only, never the personal data itself.
 */
export async function handlePrivacyRequest(
  orgId: string,
  integrationId: string,
  req: PrivacyRequest,
  event: { id: string; receivedAt: Date },
): Promise<PrivacyOutcome> {
  const who = subject(integrationId, req);
  const dueBy = new Date(event.receivedAt.getTime() + PRIVACY_DEADLINE_DAYS * DAY);

  if (req.type === "customer_data_request") {
    const summary = await withTenant(orgId, async (t) => {
      const data = await exportCustomerData(t, who);
      const doc = {
        kind: "customer_data_export",
        shop: req.shop,
        requestId: req.requestId,
        generatedAt: new Date().toISOString(),
        dueBy: dueBy.toISOString(),
        ...data,
      };
      const asset = await storeGeneratedAsset(t, {
        kind: "document",
        mime: "application/json",
        data: new TextEncoder().encode(JSON.stringify(doc, null, 2)),
      });
      await t.tx.insert(outboxEvents).values({
        orgId,
        aggregateType: "privacy_request",
        aggregateId: asset.id,
        eventType: "privacy.data_request",
        payload: {
          assetId: asset.id,
          shop: req.shop,
          orderCount: data.orders.length,
          dueBy: dueBy.toISOString(),
        },
      });
      await t.tx
        .insert(reviewQueueItems)
        .values({
          orgId,
          type: "privacy_request",
          entityType: "asset",
          entityId: asset.id,
          dueAt: dueBy,
          priority: 5,
        })
        .onConflictDoNothing();
      const counts = { customers: data.customers.length, orders: data.orders.length };
      await recordAudit(
        {
          orgId,
          actorUserId: null,
          actorType: "integration",
          action: "privacy.data_exported",
          entityType: "asset",
          entityId: asset.id,
          after: { shop: req.shop, ...counts },
        },
        t.tx,
      );
      return counts;
    });
    await redactWebhookEvent(event.id);
    kickQueue();
    return { status: "completed", summary };
  }

  const result = await withTenant(orgId, async (t) => {
    const r = await redactCustomerData(t, who);
    const snapshots = await redactFulfillmentSnapshots(t, r.redactedOrderIds);
    const summary = {
      customers: r.customersRedacted,
      orders: r.redactedOrderIds.length,
      fulfillmentSnapshots: snapshots,
      deferredOrders: r.deferredOrderIds.length,
    };
    await recordAudit(
      {
        orgId,
        actorUserId: null,
        actorType: "integration",
        action: req.type === "shop_redact" ? "privacy.shop_redacted" : "privacy.customer_redacted",
        entityType: "integration",
        entityId: integrationId,
        after: { shop: req.shop, ...summary },
      },
      t.tx,
    );
    if (r.deferredOrderIds.length) {
      const late = Date.now() - event.receivedAt.getTime() > PRIVACY_ESCALATE_DAYS * DAY;
      if (late)
        await t.tx
          .insert(reviewQueueItems)
          .values({
            orgId,
            type: "privacy_request",
            entityType: "webhook_event",
            entityId: event.id,
            dueAt: dueBy,
            priority: 10,
          })
          .onConflictDoNothing();
      const day = Math.floor(Date.now() / DAY);
      await enqueue(t, {
        kind: JOB_PRIVACY_RETRY,
        payload: { webhookEventId: event.id },
        runAt: new Date(Date.now() + PRIVACY_RETRY_HOURS * 3600_000),
        dedupeKey: `${JOB_PRIVACY_RETRY}:${event.id}:${day}`,
      });
    }
    return {
      summary,
      redactedExternalOrderIds: r.redactedExternalOrderIds,
      deferred: r.deferredOrderIds.length,
    };
  });

  await redactWebhookPayloads(
    integrationId,
    event.id,
    req.type === "shop_redact"
      ? { wholeStore: true }
      : {
          externalOrderIds: result.redactedExternalOrderIds,
          externalCustomerId: result.deferred ? null : req.customer.externalId,
          email: result.deferred ? null : req.customer.email,
        },
  );
  if (result.deferred)
    return { status: "deferred", summary: result.summary, deferredOrders: result.deferred };
  await redactWebhookEvent(event.id);
  return { status: "completed", summary: result.summary };
}
