import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import {
  auditLogs,
  brandProducts,
  fulfillmentOrders,
  integrations,
  jobQueue,
  memberships,
  notifications,
  platformAdmins,
  reviewQueueItems,
} from "@/db/schema";
import { setSessionSourceForTests } from "@/modules/auth";
import { setStorageProviderForTests } from "@/modules/assets";
import {
  listDeadLetters,
  listReviewQueue,
  resolveReviewItem,
  settleDeadLetter,
} from "@/modules/admin";
import * as disconnectRoute from "@/app/api/integrations/[id]/disconnect/route";
import * as publishRoute from "@/app/api/brand-products/[id]/publish/route";
import { callRoute } from "./cross-tenant/routes";
import { FakeSession } from "./fake-session";
import { fakeStorage } from "./fake-storage";
import { createTenant, createUser, seedBrandProduct } from "./helpers";
import { encryptSecret } from "@/modules/integrations/secrets";
import { exportedBatch } from "./fulfillment-fixtures";

const session = new FakeSession();
beforeAll(() => {
  setSessionSourceForTests(session);
  setStorageProviderForTests(fakeStorage);
});
afterAll(() => {
  setSessionSourceForTests(null);
  setStorageProviderForTests(null);
});

describe("store connections", () => {
  it("disconnect drops the token, is audited, and blocks publishing; members cannot disconnect", async () => {
    const A = await createTenant();
    const secret = encryptSecret("shpat_x");
    const [row] = await privilegedDb()
      .insert(integrations)
      .values({
        orgId: A.org.id,
        brandId: A.brand.id,
        provider: "shopify",
        externalShopId: `${crypto.randomUUID()}.myshopify.com`,
        status: "connected",
        credentialsCiphertext: secret.ciphertext,
        credentialsKeyId: secret.keyId,
      })
      .returning();
    const member = await createUser();
    await privilegedDb()
      .insert(memberships)
      .values({ orgId: A.org.id, userId: member.id, role: "member" });
    session.actAs(member);
    expect((await callRoute(disconnectRoute.POST, "POST", "http://x", row!.id)).status).toBe(403);

    session.actAs(A.owner);
    const res = await callRoute(disconnectRoute.POST, "POST", "http://x", row!.id);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toMatch(/ciphertext|shpat/);
    const [after] = await privilegedDb()
      .select()
      .from(integrations)
      .where(eq(integrations.id, row!.id));
    expect(after).toMatchObject({ status: "disconnected", credentialsCiphertext: null });
    const audits = await privilegedDb()
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.entityId, row!.id), eq(auditLogs.action, "integration.disconnected")),
      );
    expect(audits).toHaveLength(1);

    const { brandProduct } = await seedBrandProduct(A);
    await privilegedDb()
      .update(brandProducts)
      .set({ status: "approved" })
      .where(eq(brandProducts.id, brandProduct.id));
    const pub = await callRoute(publishRoute.POST, "POST", "http://x", brandProduct.id, {
      integrationId: row!.id,
    });
    expect(pub.status).toBeGreaterThanOrEqual(400);
  });
});

describe("review queue", () => {
  it("lists open items across orgs with a link to the order, and resolves them once, audited", async () => {
    const { orderId, tenant } = await exportedBatch();
    const [fo] = await privilegedDb()
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.orderId, orderId));
    const [item] = await privilegedDb()
      .insert(reviewQueueItems)
      .values({
        orgId: tenant.org.id,
        type: "failed_fulfillment",
        entityType: "fulfillment_order",
        entityId: fo!.id,
      })
      .returning();
    const admin = await createUser();
    await privilegedDb().insert(platformAdmins).values({ userId: admin.id });
    const listed = (await listReviewQueue({ userId: admin.id })).find((i) => i.id === item!.id);
    expect(listed).toMatchObject({ link: `/admin/orders/${orderId}`, orgName: tenant.org.name });

    const done = await resolveReviewItem({ userId: admin.id }, item!.id, {
      status: "done",
      note: "rerouted",
    });
    expect(done).toMatchObject({ status: "done", assigneeUserId: admin.id });
    expect(
      await resolveReviewItem({ userId: admin.id }, item!.id, { status: "done", note: null }),
    ).toBeNull();
    const audits = await privilegedDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "admin.review_item_resolved"));
    expect(
      audits.some((a) => (a.after as { reviewItemId?: string }).reviewItemId === item!.id),
    ).toBe(true);
  });
});

describe("dead letters", () => {
  it("lists dead jobs and failed emails with their org, and retries or discards each once, audited", async () => {
    const A = await createTenant();
    const admin = await createUser();
    const db = privilegedDb();
    const [retryJob, dropJob] = await db
      .insert(jobQueue)
      .values(
        ["retry", "drop"].map((k) => ({
          orgId: A.org.id,
          kind: `test.dead_${k}`,
          status: "dead" as const,
          attempts: 8,
          lastError: "boom",
        })),
      )
      .returning();
    const [email] = await db
      .insert(notifications)
      .values({
        orgId: A.org.id,
        userId: A.owner.id,
        channel: "email",
        template: "order_received",
        status: "failed",
        attempts: 5,
        lastError: "provider down",
      })
      .returning();

    const listed = await listDeadLetters({ userId: admin.id });
    expect(listed.jobs.find((j) => j.id === retryJob!.id)).toMatchObject({
      kind: "test.dead_retry",
      orgName: A.org.name,
      lastError: "boom",
    });
    expect(listed.notifications.find((n) => n.id === email!.id)).toMatchObject({
      orgName: A.org.name,
      lastError: "provider down",
    });

    const me = { userId: admin.id };
    expect(
      await settleDeadLetter(me, { kind: "job", id: retryJob!.id, action: "retry" }),
    ).not.toBeNull();
    expect(
      await settleDeadLetter(me, { kind: "job", id: retryJob!.id, action: "retry" }),
    ).toBeNull();
    expect(
      await settleDeadLetter(me, { kind: "job", id: dropJob!.id, action: "discard" }),
    ).not.toBeNull();
    expect(await settleDeadLetter(me, { kind: "notification", id: email!.id })).not.toBeNull();
    expect(await settleDeadLetter(me, { kind: "notification", id: email!.id })).toBeNull();

    const job = async (id: string) =>
      (await db.select().from(jobQueue).where(eq(jobQueue.id, id)))[0]!;
    expect(await job(retryJob!.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await job(dropJob!.id)).toMatchObject({ status: "failed" });
    const [n] = await db.select().from(notifications).where(eq(notifications.id, email!.id));
    expect(n).toMatchObject({ status: "pending", attempts: 0 });

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.orgId, A.org.id));
    expect(audits.map((a) => a.action).sort()).toEqual(
      expect.arrayContaining([
        "admin.dead_job_retry",
        "admin.dead_job_discard",
        "admin.failed_notification_retry",
      ]),
    );
    await db.delete(jobQueue).where(eq(jobQueue.id, retryJob!.id));
  });
});
