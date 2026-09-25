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

/** jsonb-safe copy: bigint money becomes its exact decimal string, Dates become ISO strings. */
export function jsonSafe(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

/** Pass `tx` to commit the audit row atomically with the change it records. */
export async function recordAudit(entry: AuditEntry, tx?: Tx) {
  await (tx ?? privilegedDb()).insert(auditLogs).values({
    ...entry,
    before: jsonSafe(entry.before),
    after: jsonSafe(entry.after),
  });
}
