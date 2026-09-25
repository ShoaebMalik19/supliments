import { withTenant } from "@/db/tenant";
import { integrations } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { ingestExternalOrder } from "@/modules/orders";
import { commerce, IntegrationUnavailableError, loadIntegration, withStore } from "./connection";
import { loadWebhookEvent, recordWebhookDelivery, settleWebhookEvent } from "./privileged";
import type { FulfillmentPush, WebhookKind } from "./provider";

export const RECONCILE_OVERLAP_MS = 5 * 60 * 1000;
export const FIRST_SYNC_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Webhook ingress (no session): verify the HMAC over the raw body before anything else, then
 * persist + enqueue and answer 200. Processing happens in the `integrations.process_webhook` job.
 */
export async function receiveShopifyWebhook(req: Request): Promise<Response> {
  const raw = await req.text();
  const provider = commerce();
  if (!provider.verifyWebhook(raw, req.headers)) return new Response(null, { status: 401 });
  const meta = provider.webhookMeta(req.headers);
  if (!meta) return new Response(null, { status: 400 });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  await recordWebhookDelivery({ provider: "shopify", ...meta, payload });
  return new Response(null, { status: 200 });
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export async function runWebhookJob(
  orgId: string,
  payload: { webhookEventId: string; kind: WebhookKind },
) {
  const ev = await loadWebhookEvent(payload.webhookEventId);
  if (!ev || ev.status === "processed" || ev.status === "ignored") return;
  const attempts = ev.attempts + 1;
  const integration = ev.integrationId ? await loadIntegration(orgId, ev.integrationId) : null;
  if (!integration) return settleWebhookEvent(ev.id, attempts, "ignored", "integration not in org");

  try {
    if (payload.kind === "order") {
      if (integration.status === "disconnected")
        return settleWebhookEvent(ev.id, attempts, "ignored", "integration disconnected");
      const notified = commerce().normalizeOrder(ev.payload);
      if (!notified) return settleWebhookEvent(ev.id, attempts, "ignored", "not a usable order");
      // The HMAC covers the body only, not the shop header: a signed body replayed under another
      // shop's header must not land in that shop's org. Ingest only the shop's own copy.
      const order = await withStore(orgId, integration.id, (conn) =>
        commerce().fetchOrder(conn, notified.externalOrderId),
      );
      if (!order)
        return settleWebhookEvent(ev.id, attempts, "ignored", "order not found in shop (replay?)");
      const result = await ingestExternalOrder({ orgId, integrationId: integration.id }, order);
      return settleWebhookEvent(
        ev.id,
        attempts,
        result.outcome === "ignored" ? "ignored" : "processed",
        result.outcome === "ignored" ? result.reason : null,
      );
    }
    if (payload.kind === "app_uninstalled") {
      await disconnectIntegration(orgId, integration.id, ev.topic);
      return settleWebhookEvent(ev.id, attempts, "processed");
    }
    return settleWebhookEvent(ev.id, attempts, "ignored", `unhandled topic ${ev.topic}`);
  } catch (e) {
    await settleWebhookEvent(ev.id, attempts, "failed", errMessage(e));
    throw e;
  }
}

/** §9.7: uninstall stops all sync; history and mappings stay. The revoked token is dropped. */
async function disconnectIntegration(orgId: string, integrationId: string, reason: string) {
  await withTenant(orgId, async (t) => {
    const before = await t.find(integrations, integrationId);
    if (!before || before.status === "disconnected") return;
    await t.update(integrations, integrationId, {
      status: "disconnected",
      credentialsCiphertext: null,
      credentialsKeyId: null,
    });
    await recordAudit(
      {
        orgId,
        actorUserId: null,
        actorType: "integration",
        action: "integration.disconnected",
        entityType: "integration",
        entityId: integrationId,
        before: { status: before.status },
        after: { status: "disconnected", reason },
      },
      t.tx,
    );
  });
}

/**
 * Polls orders updated since the last high-water mark (minus overlap; 30 days on first sync),
 * ingests each (idempotent downstream), then advances `orders_synced_through`.
 */
export async function runReconcileJob(orgId: string, payload: { integrationId: string }) {
  const integration = await loadIntegration(orgId, payload.integrationId);
  if (!integration || integration.status !== "connected") return { ingested: 0 };
  const since = integration.ordersSyncedThrough
    ? new Date(integration.ordersSyncedThrough.getTime() - RECONCILE_OVERLAP_MS)
    : new Date(Date.now() - FIRST_SYNC_LOOKBACK_MS);
  let updates;
  try {
    updates = await withStore(orgId, integration.id, (conn) =>
      commerce().fetchOrderUpdatesSince(conn, since),
    );
  } catch (e) {
    if (e instanceof IntegrationUnavailableError) return { ingested: 0 };
    throw e;
  }
  const target = { orgId, integrationId: integration.id };
  for (const order of updates.orders) await ingestExternalOrder(target, order);
  const prev = integration.ordersSyncedThrough;
  const through =
    updates.maxUpdatedAt && (!prev || updates.maxUpdatedAt > prev) ? updates.maxUpdatedAt : prev;
  await withTenant(orgId, (t) =>
    t.update(integrations, integration.id, {
      ordersSyncedThrough: through,
      lastSyncAt: new Date(),
    }),
  );
  return { ingested: updates.orders.length };
}

/**
 * Pushes one shipment (tracking + exact lines) to the store order. Idempotent per tracking
 * number: a repeated call returns the existing fulfillment instead of emailing the customer twice.
 * Throws IntegrationUnavailableError when the integration is missing in this org, disconnected
 * or needs re-auth (a 401 flips it to needs_reauth); other errors are retryable.
 */
export async function pushShipmentToStore(
  orgId: string,
  integrationId: string,
  push: FulfillmentPush,
): Promise<{ externalFulfillmentId: string }> {
  return withStore(orgId, integrationId, (conn) => commerce().pushFulfillment(conn, push));
}
