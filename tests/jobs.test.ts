import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { brands, jobQueue } from "@/db/schema";
import {
  backoffSeconds,
  drainJobs,
  drainUntilEmpty,
  enqueue,
  reclaimStaleJobs,
  registerJob,
} from "@/modules/jobs";
import { createTenant } from "./helpers";

const db = () => privilegedDb();
const jobsOfKind = (kind: string) => db().select().from(jobQueue).where(eq(jobQueue.kind, kind));

describe("job queue", () => {
  it("enqueue commits atomically with the tenant state change", async () => {
    const A = await createTenant();
    await expect(
      withTenant(A.org.id, async (t) => {
        await t.update(brands, A.brand.id, { name: "renamed" });
        await enqueue(t, { kind: "test.rollback" });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await jobsOfKind("test.rollback")).toHaveLength(0);
  });

  it("runs handlers with the job's org id", async () => {
    const A = await createTenant();
    const seen: (string | null)[] = [];
    registerJob("test.ok", async (_p, job) => {
      seen.push(job.orgId);
    });
    await withTenant(A.org.id, (t) => enqueue(t, { kind: "test.ok" }));
    await drainJobs();
    expect(seen).toEqual([A.org.id]);
    expect((await jobsOfKind("test.ok"))[0]!.status).toBe("succeeded");
  });

  it("backs off on failure and dead-letters after max attempts", async () => {
    const A = await createTenant();
    registerJob("test.fail", async () => {
      throw new Error("boom");
    });
    await withTenant(A.org.id, (t) => enqueue(t, { kind: "test.fail", maxAttempts: 2 }));
    await drainJobs();
    let [job] = await jobsOfKind("test.fail");
    expect(job).toMatchObject({ status: "pending", attempts: 1, lastError: "boom" });
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    await db()
      .update(jobQueue)
      .set({ runAt: sql`now()` })
      .where(eq(jobQueue.id, job!.id));
    await drainJobs();
    [job] = await jobsOfKind("test.fail");
    expect(job).toMatchObject({ status: "dead", attempts: 2 });
  });

  it("backoff is exponential and capped", () => {
    expect([1, 2, 3].map(backoffSeconds)).toEqual([30, 60, 120]);
    expect(backoffSeconds(20)).toBe(3600);
  });

  it("tenants cannot read the queue", async () => {
    const A = await createTenant();
    await expect(withTenant(A.org.id, (t) => t.tx.select().from(jobQueue))).rejects.toThrow();
  });
});

describe("queue reliability", () => {
  const setLock = (id: string, minutesAgo: number, attempts: number) =>
    db()
      .update(jobQueue)
      .set({
        status: "running",
        attempts,
        lockedBy: "dead-worker",
        lockedAt: new Date(Date.now() - minutesAgo * 60_000),
      })
      .where(eq(jobQueue.id, id));

  it("reclaims a job whose worker died, and runs it again", async () => {
    const A = await createTenant();
    let runs = 0;
    registerJob("test.reclaim", async () => {
      runs++;
    });
    await withTenant(A.org.id, (t) => enqueue(t, { kind: "test.reclaim" }));
    const [job] = await jobsOfKind("test.reclaim");
    await setLock(job!.id, 30, 1);
    await drainJobs();
    expect(runs).toBe(0);
    const r = await drainUntilEmpty({ budgetMs: 5_000 });
    expect(r.reclaimed).toBeGreaterThanOrEqual(1);
    expect(runs).toBe(1);
    expect((await jobsOfKind("test.reclaim"))[0]).toMatchObject({
      status: "succeeded",
      attempts: 2,
    });
  });

  it("leaves a recently locked job alone (its worker may still be running)", async () => {
    const A = await createTenant();
    registerJob("test.fresh-lock", async () => {});
    await withTenant(A.org.id, (t) => enqueue(t, { kind: "test.fresh-lock" }));
    const [job] = await jobsOfKind("test.fresh-lock");
    await setLock(job!.id, 1, 1);
    await reclaimStaleJobs();
    expect((await jobsOfKind("test.fresh-lock"))[0]!.status).toBe("running");
    await db().delete(jobQueue).where(eq(jobQueue.id, job!.id));
  });

  it("a stale job that is out of attempts is dead-lettered, not retried forever", async () => {
    const A = await createTenant();
    await withTenant(A.org.id, (t) => enqueue(t, { kind: "test.stale-dead", maxAttempts: 2 }));
    const [job] = await jobsOfKind("test.stale-dead");
    await setLock(job!.id, 30, 2);
    await reclaimStaleJobs();
    expect((await jobsOfKind("test.stale-dead"))[0]).toMatchObject({
      status: "dead",
      lastError: expect.stringContaining("stale"),
    });
  });

  it("drains a chain of jobs in one invocation", async () => {
    const A = await createTenant();
    const seen: number[] = [];
    registerJob("test.chain", async (payload) => {
      const { step } = payload as { step: number };
      seen.push(step);
      if (step < 4)
        await withTenant(A.org.id, (t) =>
          enqueue(t, { kind: "test.chain", payload: { step: step + 1 } }),
        );
    });
    await withTenant(A.org.id, (t) => enqueue(t, { kind: "test.chain", payload: { step: 1 } }));
    const r = await drainUntilEmpty({ budgetMs: 10_000 });
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(r.exhausted).toBe(false);
  });

  it("stops at the time budget and hands unstarted jobs back without spending an attempt", async () => {
    const A = await createTenant();
    registerJob("test.slow", async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    for (let i = 0; i < 4; i++)
      await withTenant(A.org.id, (t) => enqueue(t, { kind: "test.slow" }));
    const r = await drainUntilEmpty({ budgetMs: 150, limit: 4 });
    expect(r.exhausted).toBe(true);
    const rows = await jobsOfKind("test.slow");
    const pending = rows.filter((j) => j.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((j) => j.attempts === 0 && j.lockedAt === null)).toBe(true);
    await drainUntilEmpty({ budgetMs: 10_000 });
    expect((await jobsOfKind("test.slow")).every((j) => j.status === "succeeded")).toBe(true);
  });
});
