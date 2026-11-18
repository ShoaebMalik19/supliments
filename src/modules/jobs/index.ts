import { and, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { after } from "next/server";
import type { Tx } from "@/db/client";
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

/**
 * Longer than any function's lifetime: a job still `running` after this had its worker killed
 * (timeout, deploy, crash). Handlers must be idempotent, because a reclaimed job runs again.
 */
export const STALE_LOCK_SECONDS = 10 * 60;
export const KICK_BUDGET_MS = 8_000;

let lastKickAt = 0;

/**
 * Drains the queue right after the current response is sent, so work does not wait for the
 * scheduler (scheduled runs can be hours late). Outside a request (jobs, scripts, tests) it is a
 * no-op: the scheduled drain remains the backstop and the only driver of retries.
 */
export function kickQueue() {
  if (Date.now() - lastKickAt < 1_000) return;
  try {
    after(async () => {
      const { drainQueue } = await import("@/queue");
      await drainQueue({ budgetMs: KICK_BUDGET_MS }).catch((e) =>
        console.error("queue kick failed", e instanceof Error ? e.message : e),
      );
    });
    lastKickAt = Date.now();
  } catch {
    // not in a request scope
  }
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
  kickQueue();
}

/** Returns jobs whose worker died to the queue (or to `dead` once out of attempts). */
export async function reclaimStaleJobs() {
  const rows = await privilegedDb()
    .update(jobQueue)
    .set({
      status: sql`case when ${jobQueue.attempts} >= ${jobQueue.maxAttempts} then 'dead' else 'pending' end::job_status`,
      lastError: "worker lost: lock went stale",
      lockedAt: null,
      lockedBy: null,
    })
    .where(
      and(
        eq(jobQueue.status, "running"),
        lt(jobQueue.lockedAt, sql`now() - make_interval(secs => ${STALE_LOCK_SECONDS})`),
      ),
    )
    .returning({ id: jobQueue.id });
  return rows.length;
}

export function backoffSeconds(attempts: number) {
  return Math.min(30 * 2 ** (attempts - 1), 3600);
}

export type DrainSummary = { succeeded: number; retried: number; dead: number; reclaimed: number };

/**
 * Drains batch after batch until nothing is due or the time budget is spent, so a chain of jobs
 * (webhook → ingest → …) completes in one invocation instead of one step per scheduler tick.
 */
export async function drainUntilEmpty(
  opts: { budgetMs?: number; limit?: number; workerId?: string } = {},
): Promise<DrainSummary & { batches: number; exhausted: boolean }> {
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  const total = { succeeded: 0, retried: 0, dead: 0, reclaimed: await reclaimStaleJobs() };
  let batches = 0;
  for (;;) {
    if (Date.now() >= deadline) return { ...total, batches, exhausted: true };
    const r = await drainJobs({ limit: opts.limit ?? 5, workerId: opts.workerId, deadline });
    const ran = r.succeeded + r.retried + r.dead;
    if (ran === 0) return { ...total, batches, exhausted: false };
    batches++;
    total.succeeded += r.succeeded;
    total.retried += r.retried;
    total.dead += r.dead;
  }
}

export async function drainJobs(
  opts: { limit?: number; workerId?: string; deadline?: number } = {},
) {
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
    if (opts.deadline && Date.now() >= opts.deadline) {
      await db
        .update(jobQueue)
        .set({
          status: "pending",
          attempts: sql`${jobQueue.attempts} - 1`,
          lockedAt: null,
          lockedBy: null,
        })
        .where(eq(jobQueue.id, job.id));
      continue;
    }
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

export type DeadJob = {
  id: string;
  orgId: string | null;
  kind: string;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
};

export async function listDeadJobs(limit = 200): Promise<DeadJob[]> {
  return privilegedDb()
    .select({
      id: jobQueue.id,
      orgId: jobQueue.orgId,
      kind: jobQueue.kind,
      attempts: jobQueue.attempts,
      lastError: jobQueue.lastError,
      updatedAt: jobQueue.updatedAt,
    })
    .from(jobQueue)
    .where(eq(jobQueue.status, "dead"))
    .orderBy(desc(jobQueue.updatedAt))
    .limit(limit);
}

/**
 * Operator decision on a dead job: requeue with a fresh attempt budget (handlers are idempotent),
 * or discard it as `failed`, which nothing ever picks up again. Null unless the job is dead.
 */
export async function settleDeadJob(id: string, action: "retry" | "discard", tx?: Tx) {
  const [job] = await (tx ?? privilegedDb())
    .update(jobQueue)
    .set(
      action === "retry"
        ? { status: "pending", attempts: 0, runAt: new Date(), lockedAt: null, lockedBy: null }
        : { status: "failed", completedAt: new Date() },
    )
    .where(and(eq(jobQueue.id, id), eq(jobQueue.status, "dead")))
    .returning({ id: jobQueue.id, orgId: jobQueue.orgId, kind: jobQueue.kind });
  if (job && action === "retry") kickQueue();
  return job ?? null;
}
