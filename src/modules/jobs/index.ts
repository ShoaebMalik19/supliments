import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { jobQueue } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";

export type JobHandler = (
  payload: unknown,
  job: { id: string; orgId: string | null },
) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJob(kind: string, handler: JobHandler) {
  handlers.set(kind, handler);
}

/** Enqueue inside the caller's tenant transaction so the job commits with the state change. */
export async function enqueue(
  t: TenantDb,
  job: { kind: string; payload?: unknown; dedupeKey?: string; runAt?: Date; maxAttempts?: number },
) {
  await t.tx.insert(jobQueue).values({
    orgId: t.orgId,
    kind: job.kind,
    payload: job.payload ?? {},
    dedupeKey: job.dedupeKey,
    runAt: job.runAt,
    maxAttempts: job.maxAttempts,
  });
}

export function backoffSeconds(attempts: number) {
  return Math.min(30 * 2 ** (attempts - 1), 3600);
}

export async function drainJobs(opts: { limit?: number; workerId?: string } = {}) {
  const db = privilegedDb();
  const workerId = opts.workerId ?? `worker-${process.pid}`;
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: jobQueue.id })
      .from(jobQueue)
      .where(and(eq(jobQueue.status, "pending"), lte(jobQueue.runAt, sql`now()`)))
      .orderBy(jobQueue.runAt)
      .limit(opts.limit ?? 20)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(jobQueue)
      .set({
        status: "running",
        lockedAt: new Date(),
        lockedBy: workerId,
        attempts: sql`${jobQueue.attempts} + 1`,
      })
      .where(
        inArray(
          jobQueue.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
  });

  const summary = { succeeded: 0, retried: 0, dead: 0 };
  for (const job of claimed) {
    const handler = handlers.get(job.kind);
    try {
      if (!handler) throw new Error(`no handler registered for ${job.kind}`);
      await handler(job.payload, { id: job.id, orgId: job.orgId });
      await db
        .update(jobQueue)
        .set({ status: "succeeded", completedAt: new Date(), lockedAt: null, lockedBy: null })
        .where(eq(jobQueue.id, job.id));
      summary.succeeded++;
    } catch (e) {
      const dead = job.attempts >= job.maxAttempts;
      await db
        .update(jobQueue)
        .set({
          status: dead ? "dead" : "pending",
          lastError: e instanceof Error ? e.message : String(e),
          runAt: dead
            ? job.runAt
            : sql`now() + make_interval(secs => ${backoffSeconds(job.attempts)})`,
          lockedAt: null,
          lockedBy: null,
        })
        .where(eq(jobQueue.id, job.id));
      summary[dead ? "dead" : "retried"]++;
    }
  }
  return summary;
}
