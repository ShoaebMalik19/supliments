import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { auditLogs, catalogProducts, platformAdmins, skus } from "@/db/schema";
import { setSessionSourceForTests } from "@/modules/auth";
import * as productsRoute from "@/app/api/admin/catalog/products/route";
import * as productRoute from "@/app/api/admin/catalog/products/[id]/route";
import * as skusRoute from "@/app/api/admin/catalog/skus/route";
import * as skuCostsRoute from "@/app/api/admin/catalog/skus/[id]/costs/route";
import * as categoriesRoute from "@/app/api/admin/catalog/categories/route";
import { FakeSession } from "./fake-session";
import { createUser } from "./helpers";
import { seedFulfillmentCenter } from "./admin-routes";

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const session = new FakeSession();
let adminId: string;

beforeAll(async () => {
  setSessionSourceForTests(session);
  const admin = await createUser();
  adminId = admin.id;
  await privilegedDb().insert(platformAdmins).values({ userId: admin.id });
  session.actAs(admin);
});
afterAll(() => setSessionSourceForTests(null));

async function send(handler: unknown, method: string, body: unknown, id = "") {
  const res = await (handler as Handler)(
    new Request("http://test/admin", { method, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const newProduct = (over: Record<string, unknown> = {}) =>
  send(productsRoute.POST, "POST", { name: "Magnesium", currency: "USD", ...over });

describe("money validation at the admin boundary", () => {
  it.each([12.5, "12.50", "1e3", 1e21, -1, "-5", "", true, { amount: 1 }])(
    "rejects defaultMsrpMinor=%j",
    async (v) => {
      expect((await newProduct({ defaultMsrpMinor: v })).status).toBe(400);
    },
  );

  it.each(["usd", "US", "USDX", "", undefined])("rejects currency=%j", async (currency) => {
    expect((await newProduct({ currency })).status).toBe(400);
  });

  it("accepts integer minor units as number or digit string and returns them exactly", async () => {
    const a = await newProduct({ defaultMsrpMinor: 2999 });
    const b = await newProduct({ defaultMsrpMinor: "9007199254740993" });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.defaultMsrpMinor).toBe("2999");
    expect(b.body.defaultMsrpMinor).toBe("9007199254740993");
  });

  it("an amount update without its currency is rejected", async () => {
    const p = await newProduct();
    const id = p.body.id as string;
    expect((await send(productRoute.PATCH, "PATCH", { defaultMsrpMinor: 5 }, id)).status).toBe(400);
    const ok = await send(
      productRoute.PATCH,
      "PATCH",
      { defaultMsrpMinor: 5, currency: "EUR" },
      id,
    );
    expect(ok.body).toMatchObject({ defaultMsrpMinor: "5", currency: "EUR" });
  });

  it("unknown keys (e.g. orgId) are rejected rather than silently dropped", async () => {
    expect((await newProduct({ orgId: "00000000-0000-0000-0000-000000000000" })).status).toBe(400);
  });
});

describe("catalog writes", () => {
  it("each write is audit-logged as admin with before/after", async () => {
    const created = await newProduct({ defaultMsrpMinor: 100 });
    const id = created.body.id as string;
    await send(productRoute.PATCH, "PATCH", { status: "active" }, id);
    const logs = await privilegedDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.actorUserId, adminId)))
      .orderBy(auditLogs.createdAt);
    expect(logs.map((l) => [l.action, l.actorType, l.orgId])).toEqual([
      ["admin.catalog.product_created", "admin", null],
      ["admin.catalog.product_updated", "admin", null],
    ]);
    expect(logs[1]!.before).toMatchObject({ status: "draft", defaultMsrpMinor: "100" });
    expect(logs[1]!.after).toMatchObject({ status: "active" });
  });

  it("a failed write leaves no audit row and no data", async () => {
    const before = await privilegedDb().select().from(auditLogs);
    const res = await newProduct({ categoryId: "00000000-0000-7000-8000-000000000000" });
    expect(res.status).toBe(400);
    expect(await privilegedDb().select().from(auditLogs)).toHaveLength(before.length);
  });

  it("duplicate SKU codes and category slugs are 409", async () => {
    const p = await newProduct();
    const sku = { catalogProductId: p.body.id, sku: "DUP-1", baseCostMinor: 1, currency: "USD" };
    expect((await send(skusRoute.POST, "POST", sku)).status).toBe(201);
    expect((await send(skusRoute.POST, "POST", sku)).status).toBe(409);
    const cat = { name: "A", slug: "dup-slug" };
    expect((await send(categoriesRoute.POST, "POST", cat)).status).toBe(201);
    expect((await send(categoriesRoute.POST, "POST", cat)).status).toBe(409);
  });

  it("negative SKU cost is rejected before reaching the DB", async () => {
    const p = await newProduct();
    const res = await send(skusRoute.POST, "POST", {
      catalogProductId: p.body.id,
      sku: "NEG-1",
      baseCostMinor: -1,
      currency: "USD",
    });
    expect(res.status).toBe(400);
    expect(await privilegedDb().select().from(skus).where(eq(skus.sku, "NEG-1"))).toEqual([]);
  });

  it("sku costs: created per fulfillment center, 404 for unknown SKU", async () => {
    const p = await newProduct();
    const s = await send(skusRoute.POST, "POST", {
      catalogProductId: p.body.id,
      sku: "COST-1",
      baseCostMinor: 500,
      currency: "USD",
    });
    const cost = {
      fulfillmentCenterId: await seedFulfillmentCenter(),
      costMinor: 480,
      currency: "USD",
      effectiveFrom: "2026-01-01T00:00:00Z",
    };
    const ok = await send(skuCostsRoute.POST, "POST", cost, s.body.id as string);
    expect(ok).toMatchObject({ status: 201, body: { costMinor: "480" } });
    const missing = "00000000-0000-7000-8000-000000000000";
    expect((await send(skuCostsRoute.POST, "POST", cost, missing)).status).toBe(404);
  });

  it("admin sees drafts that tenants cannot", async () => {
    const p = await newProduct();
    const res = await send(productRoute.GET, "GET", undefined, p.body.id as string);
    expect(res.body).toMatchObject({ status: "draft", skus: [] });
    const [row] = await privilegedDb()
      .select()
      .from(catalogProducts)
      .where(eq(catalogProducts.id, p.body.id as string));
    expect(row!.status).toBe("draft");
  });
});
