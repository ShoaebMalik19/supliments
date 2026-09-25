import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { orderEvents, orders, orderStatus, outboxEvents } from "@/db/schema";
import {
  CANCELLABLE_STATUSES,
  IllegalTransitionError,
  ORDER_TRANSITIONS,
  TERMINAL_STATUSES,
  transitionOrder,
  type OrderStatus,
} from "@/modules/orders/state";
import { createTenant } from "./helpers";

const ALL = orderStatus.enumValues as readonly OrderStatus[];
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;

beforeAll(async () => {
  A = await createTenant("State A");
  B = await createTenant("State B");
});

async function orderIn(status: OrderStatus, tenant = A) {
  const [o] = await privilegedDb()
    .insert(orders)
    .values({
      orgId: tenant.org.id,
      brandId: tenant.brand.id,
      shipTo: {},
      currency: "USD",
      status,
    })
    .returning();
  return o!.id;
}

const move = (orderId: string, to: OrderStatus, tenant = A) =>
  withTenant(tenant.org.id, (t) =>
    transitionOrder(t, orderId, to, { type: "test", actorType: "system" }),
  );

const legal = ALL.flatMap((from) => ORDER_TRANSITIONS[from].map((to) => [from, to] as const));
const illegal = ALL.flatMap((from) =>
  ALL.filter((to) => !ORDER_TRANSITIONS[from].includes(to)).map((to) => [from, to] as const),
);

describe("order transition table", () => {
  it("covers every enum value", () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it("terminal states are exactly delivered, returned, cancelled, refunded, failed", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ["cancelled", "delivered", "failed", "refunded", "returned"].sort(),
    );
  });

  it("cancellation is only possible before submitted", () => {
    expect([...CANCELLABLE_STATUSES].sort()).toEqual(
      ["awaiting_payment", "needs_review", "on_hold", "received"].sort(),
    );
  });

  it("the happy path is a chain of legal steps", () => {
    const path: OrderStatus[] = [
      "received",
      "awaiting_payment",
      "submitted",
      "accepted",
      "in_production",
      "packed",
      "shipped",
      "in_transit",
      "delivered",
    ];
    for (let i = 1; i < path.length; i++)
      expect(ORDER_TRANSITIONS[path[i - 1]!]).toContain(path[i]);
  });

  it("awaiting_payment only leaves forward to submitted (no skipping the payment gate)", () => {
    for (const from of ["received", "needs_review", "on_hold"] as const)
      expect(ORDER_TRANSITIONS[from]).not.toContain("submitted");
  });
});

describe("transitionOrder", () => {
  it.each(legal)("%s → %s is applied with an event and an outbox row", async (from, to) => {
    const id = await orderIn(from);
    const out = await move(id, to);
    expect(out?.status).toBe(to);
    const events = await privilegedDb()
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, id));
    expect(events).toMatchObject([{ fromStatus: from, toStatus: to, type: "test" }]);
    const outbox = await privilegedDb()
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregateId, id), eq(outboxEvents.orgId, A.org.id)));
    expect(outbox).toMatchObject([{ eventType: "order.status_changed" }]);
  });

  const sample = illegal.filter((_, i) => i % 3 === 0);
  it.each(sample)("%s → %s is rejected and nothing is written", async (from, to) => {
    const id = await orderIn(from);
    await expect(move(id, to)).rejects.toBeInstanceOf(IllegalTransitionError);
    const [row] = await privilegedDb().select().from(orders).where(eq(orders.id, id));
    expect(row!.status).toBe(from);
    expect(
      await privilegedDb().select().from(orderEvents).where(eq(orderEvents.orderId, id)),
    ).toEqual([]);
  });

  it.each(TERMINAL_STATUSES.map((s) => [s]))("no transition out of terminal %s", async (from) => {
    const id = await orderIn(from);
    for (const to of ALL) await expect(move(id, to)).rejects.toThrow(IllegalTransitionError);
  });

  it("another tenant's order is invisible (null, unchanged)", async () => {
    const id = await orderIn("received", B);
    expect(await move(id, "cancelled", A)).toBeNull();
    const [row] = await privilegedDb().select().from(orders).where(eq(orders.id, id));
    expect(row!.status).toBe("received");
  });

  it("concurrent transitions serialize on the row lock: exactly one wins", async () => {
    const id = await orderIn("awaiting_payment");
    const results = await Promise.allSettled([move(id, "submitted"), move(id, "cancelled")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const events = await privilegedDb()
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, id));
    expect(events).toHaveLength(1);
  });

  it("sets and clears the hold reason", async () => {
    const id = await orderIn("received");
    await withTenant(A.org.id, (t) =>
      transitionOrder(t, id, "on_hold", {
        type: "hold",
        actorType: "admin",
        holdReason: "address",
      }),
    );
    let [row] = await privilegedDb().select().from(orders).where(eq(orders.id, id));
    expect(row!.holdReason).toBe("address");
    await move(id, "awaiting_payment");
    [row] = await privilegedDb().select().from(orders).where(eq(orders.id, id));
    expect(row!.holdReason).toBeNull();
  });
});
