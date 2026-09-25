import { eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { expect } from "vitest";
import { assets, brandProducts, brands, catalogProducts, memberships, orders } from "@/db/schema";
import {
  createAsset,
  createUser,
  ensureFeeSchedule,
  seedBrandProduct,
  seedCatalogProduct as seedCatalog,
  type createTenant,
} from "../helpers";
import { bytesOf, PNG_HEADER } from "../fake-storage";
import * as brandRoute from "@/app/api/brands/[id]/route";
import * as memberRoute from "@/app/api/members/[id]/route";
import * as catalogListRoute from "@/app/api/catalog/products/route";
import * as catalogProductRoute from "@/app/api/catalog/products/[id]/route";
import * as assetUploadsRoute from "@/app/api/assets/uploads/route";
import * as assetCompleteRoute from "@/app/api/assets/[id]/complete/route";
import * as assetUrlRoute from "@/app/api/assets/[id]/url/route";
import * as brandsRoute from "@/app/api/brands/route";
import * as brandProductsRoute from "@/app/api/brand-products/route";
import * as brandProductRoute from "@/app/api/brand-products/[id]/route";
import * as marginRoute from "@/app/api/margin/route";
import * as ordersRoute from "@/app/api/orders/route";
import * as orderRoute from "@/app/api/orders/[id]/route";
import { seedPricedOrder } from "../order-fixtures";

type Tenant = Awaited<ReturnType<typeof createTenant>>;
export type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

export async function callRoute(
  handler: Handler,
  method: string,
  url: string,
  id: string,
  body?: unknown,
) {
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handler(req, { params: Promise.resolve({ id }) });
}

export type TenantRouteCase = {
  /** Path of the route file relative to the repo root; checked by the registry meta-test. */
  file: string;
  url: (id: string) => string;
  /** Creates a row owned by `owner` and returns its id. */
  seed: (owner: Tenant) => Promise<string>;
  /** Privileged read of the row, used to prove a failed mutation changed nothing. */
  snapshot: (id: string) => Promise<unknown>;
  read: Handler[];
  mutate: { method: string; handler: Handler; body?: unknown }[];
};

/**
 * Every API route that touches tenant data MUST be listed here.
 * The meta-test in isolation.test.ts fails if a tenantRoute/withTenant route file is missing.
 */
export const tenantRoutes: TenantRouteCase[] = [
  {
    file: "src/app/api/brands/[id]/route.ts",
    url: (id) => `http://test/api/brands/${id}`,
    seed: async (b) => b.brand.id,
    snapshot: async (id) =>
      (await privilegedDb().select().from(brands).where(eq(brands.id, id)))[0],
    read: [brandRoute.GET],
    mutate: [{ method: "PATCH", handler: brandRoute.PATCH, body: { name: "pwned" } }],
  },
  {
    file: "src/app/api/members/[id]/route.ts",
    url: (id) => `http://test/api/members/${id}`,
    seed: async (b) => {
      const user = await createUser();
      const [m] = await privilegedDb()
        .insert(memberships)
        .values({ orgId: b.org.id, userId: user.id, role: "member" })
        .returning();
      return m!.id;
    },
    snapshot: async (id) =>
      (await privilegedDb().select().from(memberships).where(eq(memberships.id, id)))[0],
    read: [memberRoute.GET],
    mutate: [
      { method: "PATCH", handler: memberRoute.PATCH, body: { role: "admin" } },
      { method: "DELETE", handler: memberRoute.DELETE },
    ],
  },
  {
    file: "src/app/api/assets/[id]/url/route.ts",
    url: (id) => `http://test/api/assets/${id}/url`,
    seed: async (b) => (await createAsset(b.org.id, { uploadStatus: "ready" })).id,
    snapshot: assetSnapshot,
    read: [assetUrlRoute.GET],
    mutate: [],
  },
  {
    file: "src/app/api/assets/[id]/complete/route.ts",
    url: (id) => `http://test/api/assets/${id}/complete`,
    // A valid pending upload: if tenant A could complete it, the row would flip to `ready`.
    seed: async (b) =>
      (await createAsset(b.org.id, { bytes: 64, content: bytesOf(PNG_HEADER, 64) })).id,
    snapshot: assetSnapshot,
    read: [],
    mutate: [{ method: "POST", handler: assetCompleteRoute.POST }],
  },
  {
    file: "src/app/api/brand-products/[id]/route.ts",
    url: (id) => `http://test/api/brand-products/${id}`,
    seed: async (b) => (await seedBrandProduct(b)).brandProduct.id,
    snapshot: async (id) =>
      (await privilegedDb().select().from(brandProducts).where(eq(brandProducts.id, id)))[0],
    read: [brandProductRoute.GET],
    mutate: [{ method: "PATCH", handler: brandProductRoute.PATCH, body: { title: "pwned" } }],
  },
  {
    file: "src/app/api/orders/[id]/route.ts",
    url: (id) => `http://test/api/orders/${id}`,
    seed: seedPricedOrder,
    snapshot: async (id) =>
      (await privilegedDb().select().from(orders).where(eq(orders.id, id)))[0],
    read: [orderRoute.GET],
    mutate: [],
  },
];

async function assetSnapshot(id: string) {
  return (await privilegedDb().select().from(assets).where(eq(assets.id, id)))[0];
}

export type UnscopedCheckContext = {
  A: Tenant;
  B: Tenant;
  actAs: (user: { id: string; email: string } | null) => void;
};

export type UnscopedRouteCase = {
  file: string;
  /** Why the route has no per-row tenant case (platform data, collection or create endpoint). */
  reason: string;
  /** Runs as tenant A by default; must prove the route cannot reach or write tenant B's data. */
  check: (ctx: UnscopedCheckContext) => Promise<void>;
};

async function seedCatalogProduct(status: "active" | "draft") {
  const [p] = await privilegedDb()
    .insert(catalogProducts)
    .values({ name: `P ${status}`, currency: "USD", status, defaultMsrpMinor: 2999n })
    .returning();
  return p!.id;
}

/**
 * Tenant-context routes that do not address a single tenant-owned row. Registering here is
 * still mandatory (the meta-test counts these); each carries its own isolation check.
 */
export const unscopedTenantRoutes: UnscopedRouteCase[] = [
  {
    file: "src/app/api/catalog/products/route.ts",
    reason: "platform-owned catalog; identical for every tenant",
    check: async ({ A, B, actAs }) => {
      const list = catalogListRoute.GET as unknown as Handler;
      await seedCatalogProduct("active");
      const asA = await (
        await callRoute(list, "GET", "http://test/api/catalog/products", "")
      ).text();
      actAs(B.owner);
      const asB = await (
        await callRoute(list, "GET", "http://test/api/catalog/products", "")
      ).text();
      expect(asA).toEqual(asB);
      actAs(null);
      expect((await callRoute(list, "GET", "http://test/x", "")).status).toBe(401);
      actAs(A.owner);
    },
  },
  {
    file: "src/app/api/catalog/products/[id]/route.ts",
    reason: "platform-owned catalog; drafts hidden from every tenant",
    check: async () => {
      const draft = await seedCatalogProduct("draft");
      const active = await seedCatalogProduct("active");
      const get = catalogProductRoute.GET;
      expect((await callRoute(get, "GET", "http://test/x", draft)).status).toBe(404);
      expect((await callRoute(get, "GET", "http://test/x", active)).status).toBe(200);
    },
  },
  {
    file: "src/app/api/assets/uploads/route.ts",
    reason: "creates rows only in the caller's org; org and storage key are never client input",
    check: async ({ A, B }) => {
      const post = assetUploadsRoute.POST as unknown as Handler;
      const url = "http://test/api/assets/uploads";
      const upload = { kind: "logo", mime: "image/png", bytes: 100 };
      for (const extra of [
        { orgId: B.org.id },
        { storageKey: `org/${B.org.id}/x/y` },
        { bucket: "public" },
      ]) {
        expect((await callRoute(post, "POST", url, "", { ...upload, ...extra })).status).toBe(400);
      }
      const res = await callRoute(post, "POST", url, "", upload);
      expect(res.status).toBe(201);
      const { asset } = (await res.json()) as { asset: { id: string } };
      const row = await assetSnapshot(asset.id);
      expect(row).toMatchObject({ orgId: A.org.id, uploadedBy: A.owner.id });
      expect(row!.storageKey.startsWith(`org/${A.org.id}/${asset.id}/`)).toBe(true);
    },
  },
  {
    file: "src/app/api/brands/route.ts",
    reason: "collection + create; lists and writes only the caller's org",
    check: async ({ A, B }) => {
      const url = "http://test/api/brands";
      const list = await callRoute(brandsRoute.GET as unknown as Handler, "GET", url, "");
      const ids = ((await list.json()) as { brands: { id: string; orgId: string }[] }).brands;
      expect(ids.every((b) => b.orgId === A.org.id)).toBe(true);
      expect(ids.map((b) => b.id)).not.toContain(B.brand.id);
      const post = brandsRoute.POST as unknown as Handler;
      expect((await callRoute(post, "POST", url, "", { name: "X", orgId: B.org.id })).status).toBe(
        400,
      );
      const res = await callRoute(post, "POST", url, "", { name: "Second brand" });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { orgId: string }).orgId).toBe(A.org.id);
    },
  },
  {
    file: "src/app/api/brand-products/route.ts",
    reason: "collection + create; the referenced brand must belong to the caller",
    check: async ({ A, B }) => {
      const url = "http://test/api/brand-products";
      const { product, skus } = await seedCatalog();
      const body = (brandId: string) => ({
        brandId,
        catalogProductId: product.id,
        currency: "USD",
        variants: [{ skuId: skus[0]!.id, retailPriceMinor: 2999 }],
      });
      const post = brandProductsRoute.POST as unknown as Handler;
      expect((await callRoute(post, "POST", url, "", body(B.brand.id))).status).toBe(404);
      expect((await callRoute(post, "POST", url, "", body(A.brand.id))).status).toBe(201);
      await seedBrandProduct(B);
      const list = await callRoute(brandProductsRoute.GET as unknown as Handler, "GET", url, "");
      const rows = ((await list.json()) as { brandProducts: { orgId: string }[] }).brandProducts;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.orgId === A.org.id)).toBe(true);
    },
  },
  {
    file: "src/app/api/margin/route.ts",
    reason: "platform catalog cost + platform fee schedule; no tenant rows",
    check: async () => {
      await ensureFeeSchedule();
      const { skus } = await seedCatalog();
      const get = marginRoute.GET as unknown as Handler;
      const res = await callRoute(
        get,
        "GET",
        `http://test/api/margin?skuId=${skus[0]!.id}&retailPriceMinor=2999`,
        "",
      );
      expect(res.status).toBe(200);
    },
  },
  {
    file: "src/app/api/orders/route.ts",
    reason: "collection; lists only the caller's org orders",
    check: async ({ A, B }) => {
      const mine = await seedPricedOrder(A);
      const theirs = await seedPricedOrder(B);
      const res = await callRoute(
        ordersRoute.GET as unknown as Handler,
        "GET",
        "http://test/x",
        "",
      );
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as { orders: { id: string }[] }).orders.map((o) => o.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
    },
  },
];
