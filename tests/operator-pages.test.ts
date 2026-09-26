import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import {
  auditLogs,
  brandProducts,
  fulfillmentOrders,
  integrations,
  memberships,
  platformAdmins,
  reviewQueueItems,
} from "@/db/schema";
import { setSessionSourceForTests } from "@/modules/auth";
import { setStorageProviderForTests } from "@/modules/assets";
import { listReviewQueue, resolveReviewItem } from "@/modules/admin";
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
