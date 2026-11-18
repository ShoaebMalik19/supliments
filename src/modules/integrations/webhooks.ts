import { eq } from "drizzle-orm";
import { withTenant, type TenantDb } from "@/db/tenant";
import { integrations } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { enqueue } from "@/modules/jobs";
import type { TenantContext } from "@/modules/tenancy";
import { notFound } from "@/lib/http";
import {
  commerce,
  connectionFor,
  IntegrationUnavailableError,
  loadIntegration,
  withStore,
} from "./connection";

export const JOB_SUBSCRIBE_WEBHOOKS = "integrations.subscribe_webhooks";
export const WEBHOOK_PATH = "/api/webhooks/shopify";

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function webhookAddress(origin: string) {
  return `${origin.replace(/\/$/, "")}${WEBHOOK_PATH}`;
}

async function recordOutcome(orgId: string, integrationId: string, error: string | null) {
  await withTenant(orgId, (t) =>
    t.tx
      .update(integrations)
      .set(
        error
          ? { webhooksError: error }
          : { webhooksSubscribedAt: new Date(), webhooksError: null },
      )
      .where(eq(integrations.id, integrationId)),
  );
}

/**
 * Subscribes inside the connect request. On failure the integration records why and a job keeps
 * retrying with backoff; the reconciler still picks orders up every 15 minutes meanwhile.
 */
export async function subscribeOrSchedule(
  t: TenantDb,
  integration: typeof integrations.$inferSelect,
  address: string,
): Promise<"subscribed" | "failed"> {
  try {
    await commerce().subscribeWebhooks(connectionFor(integration), address);
    await t.update(integrations, integration.id, {
      webhooksSubscribedAt: new Date(),
      webhooksError: null,
    });
    return "subscribed";
  } catch (e) {
    await t.update(integrations, integration.id, {
      webhooksSubscribedAt: null,
      webhooksError: errMessage(e),
    });
    await scheduleSubscription(t, integration.id, address);
    return "failed";
  }
}

async function scheduleSubscription(t: TenantDb, integrationId: string, address: string) {
  await enqueue(t, {
    kind: JOB_SUBSCRIBE_WEBHOOKS,
    payload: { integrationId, address },
    dedupeKey: `webhooks:${integrationId}:${Date.now()}`,
  });
}

/** Owner/admin "Retry" on /settings/stores. */
export async function retryWebhookSubscription(
  ctx: TenantContext,
  t: TenantDb,
  integrationId: string,
  origin: string,
) {
  const i = await t.find(integrations, integrationId);
  if (!i || i.status !== "connected") throw notFound();
  await scheduleSubscription(t, i.id, webhookAddress(origin));
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "integration.webhooks_retry",
      entityType: "integration",
      entityId: i.id,
    },
    t.tx,
  );
}

export async function runSubscribeWebhooksJob(
  orgId: string,
  payload: { integrationId: string; address: string },
) {
  const integration = await loadIntegration(orgId, payload.integrationId);
  if (!integration || integration.status !== "connected") return;
  try {
    await withStore(orgId, integration.id, (conn) =>
      commerce().subscribeWebhooks(conn, payload.address),
    );
  } catch (e) {
    await recordOutcome(orgId, integration.id, errMessage(e));
    if (e instanceof IntegrationUnavailableError) return;
    throw e;
  }
  await recordOutcome(orgId, integration.id, null);
}
