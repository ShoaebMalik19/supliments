import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import {
  auditLogs,
  charges,
  feeSchedules,
  ledgerEntries,
  platformAdmins,
  reviewQueueItems,
} from "@/db/schema";
import { setSessionSourceForTests } from "@/modules/auth";
import { createFeeSchedule } from "@/modules/admin";
import { ingestExternalOrder } from "@/modules/orders";
import * as feeSchedulesRoute from "@/app/api/admin/fee-schedules/route";
import * as adminOrderRoute from "@/app/api/admin/orders/[id]/route";
import * as markPaidRoute from "@/app/api/admin/orders/[id]/mark-paid/route";
import * as resolveRoute from "@/app/api/admin/orders/[id]/resolve/route";
import { FakeSession } from "./fake-session";
import { createUser, TEST_FEE_RULES } from "./helpers";
import {
  externalOrder,
  line,
  orderReadyTenant,
  seedPricedOrder,
  seedResolvableOrder,
  type OrderTenant,
} from "./order-fixtures";

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const session = new FakeSession();
let admin: Awaited<ReturnType<typeof createUser>>;
let T: OrderTenant;

beforeAll(async () => {
  setSessionSourceForTests(session);
  admin = await createUser();
  await privilegedDb().insert(platformAdmins).values({ userId: admin.id });
  T = await orderReadyTenant("AdminOrders");
  session.actAs(admin);
});
afterAll(() => setSessionSourceForTests(null));

function call(handler: unknown, method: string, id = "", body?: unknown) {
  return (handler as Handler)(
    new Request("http://test/admin", {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

/** Starts far in the future so the schedule in force today (v1, other test files) is unchanged. */
async function latestStart() {
  const [row] = await privilegedDb()
    .select()
    .from(feeSchedules)
    .orderBy(desc(feeSchedules.effectiveFrom))
    .limit(1);
  return Math.max(row!.effectiveFrom.getTime(), Date.parse("2300-01-01T00:00:00Z"));
}

const day = 86_400_000;

describe("fee schedule versioning", () => {
  it("appends version max+1, closes the open schedule, and never reprices old orders", async () => {
    const start = new Date((await latestStart()) + 10 * day);
    const placed = new Date(start.getTime() + 5 * day);
    const ingest = () =>
      ingestExternalOrder(
        { orgId: T.org.id, integrationId: T.integration.id },
        externalOrder([line({ sku: T.skus[0]!.sku })], { placedAt: placed }),
      );
    const before = await ingest();
    if (before.outcome === "ignored") throw new Error("ignored");
    const [chargeBefore] = await privilegedDb()
      .select()
      .from(charges)
      .where(eq(charges.orderId, before.orderId));

    const res = await call(feeSchedulesRoute.POST, "POST", "", {
      currency: "USD",
      effectiveFrom: start.toISOString(),
      rules: {
        ...TEST_FEE_RULES,
        platformMarkupBps: 0,
        shipping: { firstUnitMinor: "1000", additionalUnitMinor: 0 },
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; version: number };
    const all = await privilegedDb()
      .select()
      .from(feeSchedules)
      .orderBy(desc(feeSchedules.version));
    expect(created.version).toBe(all[0]!.version);
    expect(all.filter((s) => s.effectiveTo === null).map((s) => s.id)).toEqual([created.id]);
    expect(all[1]!.effectiveTo!.getTime()).toBe(start.getTime());

    const [chargeAfter] = await privilegedDb()
      .select()
      .from(charges)
      .where(eq(charges.orderId, before.orderId));
    expect(chargeAfter).toEqual(chargeBefore);

    const after = await ingest();
    if (after.outcome === "ignored") throw new Error("ignored");
    const [newCharge] = await privilegedDb()
      .select()
      .from(charges)
      .where(eq(charges.orderId, after.orderId));
    // cogs 850 + fee 250+75 + shipping 1000 + markup 0
    expect(newCharge).toMatchObject({ amountMinor: 2175n, feeScheduleId: created.id });
    expect(chargeBefore!.amountMinor).not.toBe(newCharge!.amountMinor);

    const audits = await privilegedDb()
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.entityId, created.id), eq(auditLogs.action, "admin.fee_schedule_created")),
      );
    expect(audits).toMatchObject([{ actorType: "admin", actorUserId: admin.id }]);
  });

  it("rejects invalid rules, decimals and a start not after the newest version", async () => {
    const future = new Date((await latestStart()) + day).toISOString();
    const bad = [
      {
        currency: "USD",
        effectiveFrom: future,
        rules: { ...TEST_FEE_RULES, platformMarkupBps: -1 },
      },
      {
        currency: "USD",
        effectiveFrom: future,
        rules: { ...TEST_FEE_RULES, perOrderFulfillmentFeeMinor: "2.50" },
      },
      { currency: "usd", effectiveFrom: future, rules: TEST_FEE_RULES },
      { currency: "USD", effectiveFrom: "2021-01-01T00:00:00Z", rules: TEST_FEE_RULES },
    ];
    for (const body of bad)
      expect((await call(feeSchedulesRoute.POST, "POST", "", body)).status).toBe(400);
  });

  it("concurrent creations get distinct consecutive versions", async () => {
    const base = await latestStart();
    const results = await Promise.allSettled(
      [1, 2, 3].map((n) =>
        createFeeSchedule(
          { userId: admin.id },
          {
            currency: "USD",
            effectiveFrom: new Date(base + n * 1000 * day).toISOString(),
            rules: TEST_FEE_RULES,
          },
        ),
      ),
    );
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.version] : []));
    expect(new Set(ok).size).toBe(ok.length);
    const open = await privilegedDb().select().from(feeSchedules);
    expect(open.filter((s) => s.effectiveTo === null)).toHaveLength(1);
  });

  it("GET lists versions newest first", async () => {
    const res = await call(feeSchedulesRoute.GET, "GET");
    const { feeSchedules: rows } = (await res.json()) as { feeSchedules: { version: number }[] };
    expect(rows.map((r) => r.version)).toEqual(
      [...rows.map((r) => r.version)].sort((a, b) => b - a),
    );
  });
});

describe("admin orders", () => {
  it("mark-paid is idempotent over HTTP and audited as admin", async () => {
    const id = await seedPricedOrder(T);
    const first = await call(markPaidRoute.POST, "POST", id, { reference: "WIRE-9" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      alreadyPaid: false,
      charge: { status: "succeeded" },
    });
    const second = await call(markPaidRoute.POST, "POST", id, { reference: "WIRE-9" });
    expect(await second.json()).toMatchObject({ alreadyPaid: true });
    const payments = await privilegedDb()
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.orderId, id), eq(ledgerEntries.account, "payment")));
    expect(payments).toHaveLength(1);
    const audits = await privilegedDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "admin.order_payment_recorded"));
    expect(audits.filter((a) => (a.after as { orderId: string }).orderId === id)).toMatchObject([
      { actorType: "admin", actorUserId: admin.id, orgId: T.org.id },
    ]);
  });

  it("mark-paid requires a reference and 404s unknown orders", async () => {
    const id = await seedPricedOrder(T);
    expect((await call(markPaidRoute.POST, "POST", id, {})).status).toBe(400);
    expect(
      (await call(markPaidRoute.POST, "POST", id, { reference: "x", amountMinor: 1 })).status,
    ).toBe(400);
    const missing = "01900000-0000-7000-8000-000000000000";
    expect((await call(markPaidRoute.POST, "POST", missing, { reference: "x" })).status).toBe(404);
    expect((await call(adminOrderRoute.GET, "GET", "nope")).status).toBe(404);
  });

  it("resolve prices a fixed order and closes its review item", async () => {
    const id = await seedResolvableOrder(T);
    const open = () =>
      privilegedDb()
        .select()
        .from(reviewQueueItems)
        .where(and(eq(reviewQueueItems.entityId, id), eq(reviewQueueItems.status, "open")));
    expect(await open()).toHaveLength(1);
    const res = await call(resolveRoute.POST, "POST", id);
    expect(await res.json()).toEqual({ status: "awaiting_payment" });
    expect(await open()).toEqual([]);
    expect((await call(resolveRoute.POST, "POST", id)).status).toBe(409);
  });

  it("GET returns items, charge, ledger and timeline, and audits the view", async () => {
    const id = await seedPricedOrder(T);
    const res = await call(adminOrderRoute.GET, "GET", id);
    const body = (await res.json()) as {
      orgId: string;
      charge: { amountMinor: string };
      ledger: { balanceMinor: string };
      timeline: unknown[];
    };
    expect(body.orgId).toBe(T.org.id);
    expect(body.ledger.balanceMinor).toBe(body.charge.amountMinor);
    expect(body.timeline).toHaveLength(2);
    const audits = await privilegedDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "admin.order_viewed")));
    expect(audits).toHaveLength(1);
  });
});
