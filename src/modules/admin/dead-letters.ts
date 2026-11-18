import { inArray } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { auditLogs, organizations } from "@/db/schema";
import { listDeadJobs, settleDeadJob } from "@/modules/jobs";
import { listFailedNotifications, retryFailedNotification } from "@/modules/notifications";

async function orgNames(ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await privilegedDb()
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(inArray(organizations.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Work the system gave up on: dead jobs and emails that exhausted their attempts. */
export async function listDeadLetters(admin: { userId: string }) {
  const [jobs, emails] = await Promise.all([listDeadJobs(), listFailedNotifications()]);
  const names = await orgNames([...jobs.map((j) => j.orgId), ...emails.map((n) => n.orgId)]);
  await privilegedDb()
    .insert(auditLogs)
    .values({
      orgId: null,
      actorUserId: admin.userId,
      actorType: "admin",
      action: "admin.dead_letters_listed",
      entityType: "job_queue",
      after: { jobs: jobs.length, notifications: emails.length },
    });
  const orgName = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return {
    jobs: jobs.map((j) => ({ ...j, orgName: orgName(j.orgId) })),
    notifications: emails.map((n) => ({ ...n, orgName: orgName(n.orgId) })),
  };
}

export async function settleDeadLetter(
  admin: { userId: string },
  input:
    { kind: "job"; id: string; action: "retry" | "discard" } | { kind: "notification"; id: string },
) {
  return privilegedDb().transaction(async (tx) => {
    const row =
      input.kind === "job"
        ? await settleDeadJob(input.id, input.action, tx)
        : await retryFailedNotification(input.id, tx);
    if (!row) return null;
    await tx.insert(auditLogs).values({
      orgId: row.orgId,
      actorUserId: admin.userId,
      actorType: "admin",
      action:
        input.kind === "job" ? `admin.dead_job_${input.action}` : "admin.failed_notification_retry",
      entityType: input.kind === "job" ? "job_queue" : "notification",
      entityId: row.id,
      after: "kind" in row ? { jobKind: row.kind } : { template: row.template },
    });
    return row;
  });
}
