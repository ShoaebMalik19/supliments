import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, isNull } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { memberships, notifications, outboxEvents } from "@/db/schema";
import { resendEmail, setResendFetchForTests } from "@/adapters/resend/email";
import {
  MAX_SEND_ATTEMPTS,
  publishOutbox,
  renderEmail,
  sendPendingNotifications,
  setEmailProviderForTests,
  templateFor,
  type EmailMessage,
} from "@/modules/notifications";
import { transitionOrder } from "@/modules/orders";
import { createTenant, createUser } from "./helpers";
import { ingestStandardOrder, orderReadyTenant } from "./order-fixtures";

const db = () => privilegedDb();
const sent: EmailMessage[] = [];
let failNext = 0;
const provider = {
  send: async (m: EmailMessage) => {
    if (failNext > 0) {
      failNext--;
      throw new Error("smtp down");
    }
    sent.push(m);
    return { providerMessageId: "x" };
  },
};

beforeAll(async () => {
  await db()
    .update(outboxEvents)
    .set({ publishedAt: new Date() })
    .where(isNull(outboxEvents.publishedAt));
  await db()
    .update(notifications)
    .set({ status: "read" })
    .where(eq(notifications.status, "pending"));
});
beforeEach(() => {
  sent.length = 0;
  failNext = 0;
  setEmailProviderForTests(provider);
});
afterAll(() => setEmailProviderForTests(undefined));

const forOrg = (orgId: string) =>
  db().select().from(notifications).where(eq(notifications.orgId, orgId));

async function tenantWithTeam() {
  const t = await orderReadyTenant("Notify");
  const admin = await createUser();
  const member = await createUser();
  await db()
    .insert(memberships)
    .values([
      { orgId: t.org.id, userId: admin.id, role: "admin" },
      { orgId: t.org.id, userId: member.id, role: "member" },
    ]);
  return { t, admin, member };
}

describe("outbox → notifications", () => {
  it("an ingested order notifies the org's owner and admin exactly once, and nobody else", async () => {
    const { t, admin, member } = await tenantWithTeam();
    const other = await createTenant("Bystander org");
    await ingestStandardOrder(t);
    await publishOutbox();
    await publishOutbox();
    const rows = await forOrg(t.org.id);
    expect(rows.map((r) => r.template)).toEqual(["order_received", "order_received"]);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([t.owner.id, admin.id]));
    expect(rows.some((r) => r.userId === member.id)).toBe(false);
    expect(await forOrg(other.org.id)).toEqual([]);

    await sendPendingNotifications();
    expect(sent.map((m) => m.to).sort()).toEqual([t.owner.email, admin.email].sort());
    expect(sent[0]!.subject).toBe("Order #1001 received");
    expect(sent[0]!.idempotencyKey).toMatch(/^notification-[0-9a-f-]{36}$/);
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(2);
    await sendPendingNotifications();
    expect(sent).toHaveLength(2);
    expect((await forOrg(t.org.id)).every((r) => r.status === "sent" && r.sentAt)).toBe(true);
  });

  it("holds and shipments produce their own emails; other transitions produce none", async () => {
    const t = await orderReadyTenant("Notify2");
    const { res } = await ingestStandardOrder(t);
    if (res.outcome !== "created") throw new Error();
    await publishOutbox();
    await db()
      .update(notifications)
      .set({ status: "read" })
      .where(eq(notifications.orgId, t.org.id));
    await withTenant(t.org.id, async (tx) => {
      await transitionOrder(tx, res.orderId, "on_hold", {
        type: "manual_hold",
        actorType: "admin",
        holdReason: "address looks wrong",
      });
      await transitionOrder(tx, res.orderId, "awaiting_payment", {
        type: "released",
        actorType: "admin",
      });
      await transitionOrder(tx, res.orderId, "submitted", {
        type: "submitted",
        actorType: "system",
      });
      await transitionOrder(tx, res.orderId, "shipped", {
        type: "fulfillment_shipped",
        actorType: "system",
        payload: { carrier: "UPS", trackingNumber: "1Z999" },
      });
    });
    await publishOutbox();
    await sendPendingNotifications();
    expect(sent.map((m) => m.subject)).toEqual([
      "Action needed on order #1001",
      "Order #1001 received",
      "Order #1001 shipped",
    ]);
    expect(sent[0]!.text).toContain("address looks wrong");
    expect(sent[2]!.text).toContain("1Z999");
    expect(await db().select().from(outboxEvents).where(isNull(outboxEvents.publishedAt))).toEqual(
      [],
    );
  });

  it("a failing provider keeps the email pending, then gives up after the attempt limit", async () => {
    const t = await orderReadyTenant("Notify3");
    await ingestStandardOrder(t);
    await publishOutbox();
    failNext = 1;
    expect(await sendPendingNotifications()).toMatchObject({ sent: 0, retrying: 1 });
    let [row] = await forOrg(t.org.id);
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "smtp down" });
    await sendPendingNotifications();
    [row] = await forOrg(t.org.id);
    expect(row).toMatchObject({ status: "sent", attempts: 2, lastError: null });

    const t2 = await orderReadyTenant("Notify4");
    await ingestStandardOrder(t2);
    await publishOutbox();
    failNext = 99;
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) await sendPendingNotifications();
    expect((await forOrg(t2.org.id))[0]).toMatchObject({
      status: "failed",
      attempts: MAX_SEND_ATTEMPTS,
    });
  });

  it("with no provider configured nothing is sent and nothing is lost", async () => {
    const t = await orderReadyTenant("Notify5");
    await ingestStandardOrder(t);
    await publishOutbox();
    setEmailProviderForTests(null);
    expect(await sendPendingNotifications()).toEqual({
      configured: false,
      sent: 0,
      failed: 0,
      retrying: 0,
    });
    expect((await forOrg(t.org.id))[0]).toMatchObject({ status: "pending", attempts: 0 });
    setEmailProviderForTests(provider);
    expect((await sendPendingNotifications()).sent).toBe(1);
  });

  it("tenants cannot read another org's notifications", async () => {
    const a = await orderReadyTenant("NotifyA");
    const b = await createTenant("NotifyB");
    await ingestStandardOrder(a);
    await publishOutbox();
    const seen = await withTenant(b.org.id, (tx) => tx.tx.select().from(notifications));
    expect(seen).toEqual([]);
    const ids = (await forOrg(a.org.id)).map((r) => r.id);
    await db().update(notifications).set({ status: "read" }).where(inArray(notifications.id, ids));
  });
});

describe("templates", () => {
  it("map events to emails and ignore the rest", () => {
    const ev = (to: string, from = "received") => ({
      eventType: "order.status_changed",
      payload: { to, from },
    });
    expect(templateFor(ev("awaiting_payment"))).toBe("order_received");
    expect(templateFor(ev("needs_review"))).toBe("order_action_required");
    expect(templateFor(ev("shipped", "submitted"))).toBe("order_shipped");
    expect(templateFor(ev("submitted"))).toBeNull();
    expect(templateFor(ev("delivered"))).toBeNull();
    expect(templateFor({ eventType: "label.rejected", payload: {} })).toBe("label_rejected");
    expect(templateFor({ eventType: "something.else", payload: {} })).toBeNull();
  });

  it("strips control characters so store-supplied text cannot forge headers or lines", () => {
    const e = renderEmail(
      "order_received",
      { orderNumber: "#1\r\nBcc: evil@x.test", orderId: "abc" },
      "https://app.test/",
    );
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.text).toContain("https://app.test/orders/abc");
    const r = renderEmail(
      "label_rejected",
      { productTitle: "Creatine", reason: "logo\u0000 too small", labelId: "l1" },
      "https://app.test",
    );
    expect(r.text).toContain("logo too small");
  });
});

describe("resend adapter", () => {
  it("posts plain text with the idempotency key and throws on a non-2xx", async () => {
    const saved = { k: process.env.RESEND_API_KEY, f: process.env.EMAIL_FROM };
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "Ops <ops@example.com>";
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 200;
    setResendFetchForTests(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ id: "em_1" }), { status });
    });
    try {
      const r = await resendEmail.send({
        to: "a@b.test",
        subject: "S",
        text: "T",
        idempotencyKey: "notification-1",
      });
      expect(r.providerMessageId).toBe("em_1");
      const h = new Headers(calls[0]!.init.headers);
      expect(calls[0]!.url).toBe("https://api.resend.com/emails");
      expect(h.get("idempotency-key")).toBe("notification-1");
      expect(h.get("authorization")).toBe("Bearer re_test");
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
        from: "Ops <ops@example.com>",
        to: ["a@b.test"],
        subject: "S",
        text: "T",
      });
      status = 429;
      await expect(
        resendEmail.send({ to: "a@b.test", subject: "S", text: "T", idempotencyKey: "k" }),
      ).rejects.toThrow("429");
    } finally {
      setResendFetchForTests(null);
      process.env.RESEND_API_KEY = saved.k;
      process.env.EMAIL_FROM = saved.f;
    }
  });
});
