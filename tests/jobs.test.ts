import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { brands, jobQueue } from "@/db/schema";
import { backoffSeconds, drainJobs, enqueue, registerJob } from "@/modules/jobs";
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
