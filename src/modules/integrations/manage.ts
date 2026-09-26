import { asc, eq } from "drizzle-orm";
import type { TenantDb } from "@/db/tenant";
import { integrations } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import type { TenantContext } from "@/modules/tenancy";
import { integrationView } from "./connection";

export async function listIntegrations(t: TenantDb) {
  const rows = await t.tx
    .select()
    .from(integrations)
    .where(eq(integrations.orgId, t.orgId))
    .orderBy(asc(integrations.createdAt));
  return rows.map(integrationView);
}

/**
 * Brand-initiated disconnect: stop all sync and drop the token; history and mappings stay so a
 * reconnect of the same shop reattaches (§9.7). The app stays installed in Shopify until the
 * merchant uninstalls it; webhooks for a disconnected integration are ignored.
 */
export async function disconnectIntegration(ctx: TenantContext, t: TenantDb, id: string) {
  const before = await t.find(integrations, id);
  if (!before) return null;
  if (before.status === "disconnected") return integrationView(before);
  const after = (await t.update(integrations, id, {
    status: "disconnected",
    credentialsCiphertext: null,
    credentialsKeyId: null,
  }))!;
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "integration.disconnected",
      entityType: "integration",
      entityId: id,
      before: { status: before.status },
      after: { status: after.status, reason: "user" },
    },
    t.tx,
  );
  return integrationView(after);
}
