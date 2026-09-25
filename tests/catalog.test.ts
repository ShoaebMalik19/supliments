import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { catalogProducts, skus } from "@/db/schema";
import { setSessionSourceForTests } from "@/modules/auth";
import * as listRoute from "@/app/api/catalog/products/route";
import * as detailRoute from "@/app/api/catalog/products/[id]/route";
import { FakeSession } from "./fake-session";
import { createTenant } from "./helpers";
import { callRoute, type Handler } from "./cross-tenant/routes";

const session = new FakeSession();
let tenant: Awaited<ReturnType<typeof createTenant>>;

async function product(status: "draft" | "active" | "discontinued", name = `P-${status}`) {
  const [p] = await privilegedDb()
    .insert(catalogProducts)
    .values({ name, status, currency: "USD", defaultMsrpMinor: 9007199254740993n })
    .returning();
  return p!;
}

beforeAll(async () => {
  setSessionSourceForTests(session);
  tenant = await createTenant();
  session.actAs(tenant.owner);
});
afterAll(() => setSessionSourceForTests(null));

describe("tenant catalog browse", () => {
  it("lists only active products", async () => {
    const [a, d, x] = [
      await product("active"),
      await product("draft"),
      await product("discontinued"),
    ];
    const res = await callRoute(listRoute.GET as unknown as Handler, "GET", "http://t/", "");
    const ids = ((await res.json()) as { products: { id: string }[] }).products.map((p) => p.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(d.id);
    expect(ids).not.toContain(x.id);
  });

  it("detail returns active SKUs only, money as exact minor-unit strings", async () => {
    const p = await product("active");
    await privilegedDb()
      .insert(skus)
      .values([
        { catalogProductId: p.id, sku: `on-${p.id}`, baseCostMinor: 1250n, currency: "USD" },
        {
          catalogProductId: p.id,
          sku: `off-${p.id}`,
          baseCostMinor: 1n,
          currency: "USD",
          isActive: false,
        },
      ]);
    const res = await callRoute(detailRoute.GET, "GET", "http://t/", p.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      defaultMsrpMinor: string;
      skus: { sku: string; baseCostMinor: string; currency: string }[];
    };
    expect(body.defaultMsrpMinor).toBe("9007199254740993");
    expect(body.skus).toEqual([
      expect.objectContaining({ sku: `on-${p.id}`, baseCostMinor: "1250", currency: "USD" }),
    ]);
  });

  it("draft and discontinued products are 404", async () => {
    for (const s of ["draft", "discontinued"] as const) {
      const p = await product(s);
      expect((await callRoute(detailRoute.GET, "GET", "http://t/", p.id)).status).toBe(404);
    }
  });

  it("tenants cannot write catalog tables even with raw SQL", async () => {
    const p = await product("active");
    await expect(
      withTenant(tenant.org.id, (t) =>
        t.tx.insert(catalogProducts).values({ name: "x", currency: "USD" }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(tenant.org.id, (t) =>
        t.tx.update(catalogProducts).set({ status: "draft" }).where(eq(catalogProducts.id, p.id)),
      ),
    ).rejects.toThrow();
  });
});
