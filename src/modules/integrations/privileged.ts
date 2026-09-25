import { and, eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { integrations, jobQueue, reviewQueueItems, webhookEvents } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import type { WebhookKind } from "./provider";

/**
 * The only RLS-bypassing code in the integrations module (ESLint allowlist). Everything here
 * runs before a tenant is known (webhook ingress, OAuth hijack detection) or spans all tenants
 * (reconciliation scheduling), and only ever targets the integration that owns a shop.
 */

export const JOB_PROCESS_WEBHOOK = "integrations.process_webhook";
export const JOB_RECONCILE = "integrations.reconcile";
export const JOB_PUBLISH_PRODUCT = "integrations.publish_product";

export const RECONCILE_BUCKET_MS = 15 * 60 * 1000;

/** Which org (if any) owns this shop. Used only to refuse cross-org connects. */
export async function shopOwner(provider: "shopify", externalShopId: string) {
  const [row] = await privilegedDb()
    .select({ id: integrations.id, orgId: integrations.orgId, status: integrations.status })
    .from(integrations)
    .where(
      and(eq(integrations.provider, provider), eq(integrations.externalShopId, externalShopId)),
    );
  return row ?? null;
}

/**
 * Persists a verified webhook and enqueues its processing in one transaction. The job is
 * scoped to the org that owns the shop — the only org this delivery can ever reach.
 * A redelivery (same dedupe key) is a no-op.
 */
export async function recordWebhookDelivery(input: {
  provider: "shopify";
  shop: string;
  topic: string;
  kind: WebhookKind;
  eventId: string;
  payload: unknown;
}): Promise<{ webhookEventId: string | null; duplicate: boolean; orgId: string | null }> {
  return privilegedDb().transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: integrations.id, orgId: integrations.orgId })
      .from(integrations)
      .where(
        and(eq(integrations.provider, input.provider), eq(integrations.externalShopId, input.shop)),
      );
    const [event] = await tx
      .insert(webhookEvents)
      .values({
        provider: input.provider,
        integrationId: owner?.id ?? null,
        topic: input.topic,
        externalEventId: input.eventId,
        payload: input.payload,
        signatureValid: true,
        status: owner ? "received" : "ignored",
        error: owner ? null : "no integration for shop",
        processedAt: owner ? null : new Date(),
        dedupeKey: `${input.provider}:${input.eventId}`,
      })
      .onConflictDoNothing({ target: webhookEvents.dedupeKey })
      .returning({ id: webhookEvents.id });
    if (!event) return { webhookEventId: null, duplicate: true, orgId: owner?.orgId ?? null };
    if (owner)
      await tx.insert(jobQueue).values({
        orgId: owner.orgId,
        kind: JOB_PROCESS_WEBHOOK,
        payload: { webhookEventId: event.id, kind: input.kind },
        dedupeKey: `${JOB_PROCESS_WEBHOOK}:${event.id}`,
      });
    return { webhookEventId: event.id, duplicate: false, orgId: owner?.orgId ?? null };
  });
}

export async function loadWebhookEvent(id: string) {
  const [row] = await privilegedDb().select().from(webhookEvents).where(eq(webhookEvents.id, id));
  return row ?? null;
}

export async function settleWebhookEvent(
  id: string,
  attempts: number,
  status: "processed" | "ignored" | "failed",
  error: string | null = null,
) {
  await privilegedDb()
    .update(webhookEvents)
    .set({
      status,
      error,
      attempts,
      processedAt: status === "failed" ? null : new Date(),
    })
    .where(eq(webhookEvents.id, id));
}

/** One reconcile job per connected integration per 15-minute bucket. Returns jobs created. */
export async function scheduleReconciliation(now = new Date()) {
  const db = privilegedDb();
  const bucket = Math.floor(now.getTime() / RECONCILE_BUCKET_MS);
  const connected = await db
    .select({ id: integrations.id, orgId: integrations.orgId })
    .from(integrations)
    .where(eq(integrations.status, "connected"));
  if (connected.length === 0) return 0;
  const created = await db
    .insert(jobQueue)
    .values(
      connected.map((i) => ({
        orgId: i.orgId,
        kind: JOB_RECONCILE,
        payload: { integrationId: i.id },
        dedupeKey: `${JOB_RECONCILE}:${i.id}:${bucket}`,
      })),
    )
    .onConflictDoNothing({ target: jobQueue.dedupeKey })
    .returning({ id: jobQueue.id });
  return created.length;
}

/**
 * A shop already connected to another org tried to connect here (§9.7 data-leak vector):
 * refused, audited on both sides, and queued for manual review.
 */
export async function flagIntegrationConflict(input: {
  requestingOrgId: string;
  userId: string;
  shop: string;
  existing: { id: string; orgId: string };
}) {
  await privilegedDb().transaction(async (tx) => {
    await tx
      .insert(reviewQueueItems)
      .values({
        orgId: input.requestingOrgId,
        type: "integration_conflict",
        entityType: "integration",
        entityId: input.existing.id,
        priority: 10,
      })
      .onConflictDoNothing();
    await recordAudit(
      {
        orgId: input.requestingOrgId,
        actorUserId: input.userId,
        actorType: "user",
        action: "integration.connect_refused",
        entityType: "integration",
        entityId: input.existing.id,
        after: { shop: input.shop, reason: "shop_connected_to_another_org" },
      },
      tx,
    );
    await recordAudit(
      {
        orgId: input.existing.orgId,
        actorUserId: null,
        actorType: "system",
        action: "integration.foreign_connect_attempt",
        entityType: "integration",
        entityId: input.existing.id,
        after: { shop: input.shop },
      },
      tx,
    );
  });
}
