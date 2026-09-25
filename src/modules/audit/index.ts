import { auditLogs } from "@/db/schema";
import { privilegedDb } from "@/db/privileged";
import type { Tx } from "@/db/client";

export type AuditEntry = {
  orgId: string | null;
  actorUserId: string | null;
  actorType: "user" | "admin" | "system" | "integration";
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
};

/** Pass `tx` to commit the audit row atomically with the change it records. */
export async function recordAudit(entry: AuditEntry, tx?: Tx) {
  await (tx ?? privilegedDb()).insert(auditLogs).values({
    ...entry,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}
