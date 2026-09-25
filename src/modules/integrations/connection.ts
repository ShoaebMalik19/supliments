import { and, eq } from "drizzle-orm";
import { shopify } from "@/adapters/shopify";
import { withTenant } from "@/db/tenant";
import { integrations } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { ProviderAuthError, type CommerceProvider, type StoreConnection } from "./provider";
import { decryptSecret } from "./secrets";

export type Integration = typeof integrations.$inferSelect;

export const commerce = (): CommerceProvider => shopify;

/** Public shape of an integration. Credentials never leave the module. */
export const integrationView = (i: Integration) => ({
  id: i.id,
  provider: i.provider,
  domain: i.domain,
  brandId: i.brandId,
  status: i.status,
  scopes: i.scopes,
  installedAt: i.installedAt,
  lastSyncAt: i.lastSyncAt,
  ordersSyncedThrough: i.ordersSyncedThrough,
});

/** The integration cannot be used right now: missing in this org, disconnected, or needs re-auth. */
export class IntegrationUnavailableError extends Error {
  constructor(readonly reason: "not_found" | "needs_reauth" | "disconnected") {
    super(`integration unavailable: ${reason}`);
    this.name = "IntegrationUnavailableError";
  }
}

export function connectionFor(i: Integration): StoreConnection {
  if (i.status !== "connected") throw new IntegrationUnavailableError(i.status);
  if (!i.credentialsCiphertext || !i.credentialsKeyId || !i.domain)
    throw new IntegrationUnavailableError("needs_reauth");
  return {
    shop: i.domain,
    accessToken: decryptSecret(i.credentialsCiphertext, i.credentialsKeyId),
  };
}

export async function loadIntegration(orgId: string, integrationId: string) {
  return withTenant(orgId, (t) => t.find(integrations, integrationId));
}

/** §9.7: a 401 halts all pushes until the brand re-authorizes. */
export async function markNeedsReauth(orgId: string, integrationId: string, reason: string) {
  await withTenant(orgId, async (t) => {
    const [changed] = await t.tx
      .update(integrations)
      .set({ status: "needs_reauth" })
      .where(
        and(
          eq(integrations.id, integrationId),
          eq(integrations.orgId, orgId),
          eq(integrations.status, "connected"),
        ),
      )
      .returning({ id: integrations.id });
    if (changed)
      await recordAudit(
        {
          orgId,
          actorUserId: null,
          actorType: "integration",
          action: "integration.needs_reauth",
          entityType: "integration",
          entityId: integrationId,
          after: { reason },
        },
        t.tx,
      );
  });
}

/**
 * Runs `fn` against the store with decrypted credentials. A 401 from the store flips the
 * integration to needs_reauth and surfaces as IntegrationUnavailableError.
 */
export async function withStore<R>(
  orgId: string,
  integrationId: string,
  fn: (conn: StoreConnection, integration: Integration) => Promise<R>,
): Promise<R> {
  const integration = await loadIntegration(orgId, integrationId);
  if (!integration) throw new IntegrationUnavailableError("not_found");
  const conn = connectionFor(integration);
  try {
    return await fn(conn, integration);
  } catch (e) {
    if (e instanceof ProviderAuthError) {
      await markNeedsReauth(orgId, integrationId, e.message);
      throw new IntegrationUnavailableError("needs_reauth");
    }
    throw e;
  }
}
