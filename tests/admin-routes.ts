import { privilegedDb } from "@/db/privileged";
import { catalogProducts, categories, fulfillmentCenters, skus } from "@/db/schema";
import type { createTenant } from "./helpers";
import * as adminOrgRoute from "@/app/api/admin/orgs/[id]/route";
import * as categoriesRoute from "@/app/api/admin/catalog/categories/route";
import * as categoryRoute from "@/app/api/admin/catalog/categories/[id]/route";
import * as productsRoute from "@/app/api/admin/catalog/products/route";
import * as productRoute from "@/app/api/admin/catalog/products/[id]/route";
import * as skusRoute from "@/app/api/admin/catalog/skus/route";
import * as skuRoute from "@/app/api/admin/catalog/skus/[id]/route";
import * as skuCostsRoute from "@/app/api/admin/catalog/skus/[id]/costs/route";

type Tenant = Awaited<ReturnType<typeof createTenant>>;
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof HTTP_METHODS)[number];

export type AdminRouteCase = {
  /** Route file relative to the repo root; the meta-test requires every admin route file here. */
  file: string;
  module: object;
  /** Seeds a real target row (for [id] routes) so the non-admin 404 is not a missing-row 404. */
  id?: (tenant: Tenant) => Promise<string>;
  /** A body that a platform admin's request would succeed with. */
  body?: (id: string) => unknown;
};

const uniq = () => Math.random().toString(36).slice(2, 10);

async function seedCategory() {
  const [c] = await privilegedDb()
    .insert(categories)
    .values({ name: "Seed", slug: `seed-${uniq()}` })
    .returning();
  return c!.id;
}

async function seedProduct() {
  const [p] = await privilegedDb()
    .insert(catalogProducts)
    .values({ name: "Seed", currency: "USD" })
    .returning();
  return p!.id;
}

async function seedSku() {
  const [s] = await privilegedDb()
    .insert(skus)
    .values({
      catalogProductId: await seedProduct(),
      sku: `S-${uniq()}`,
      baseCostMinor: 100n,
      currency: "USD",
    })
    .returning();
  return s!.id;
}

export async function seedFulfillmentCenter() {
  const [fc] = await privilegedDb()
    .insert(fulfillmentCenters)
    .values({ name: "FC", address: {}, country: "US" })
    .returning();
  return fc!.id;
}

let fcId: string | undefined;
let productId: string | undefined;

/** Every route under src/app/api/admin MUST be listed; non-admins must get 404 on every method. */
export const adminRoutes: AdminRouteCase[] = [
  {
    file: "src/app/api/admin/orgs/[id]/route.ts",
    module: adminOrgRoute,
    id: async (t) => t.org.id,
    body: () => ({ status: "suspended" }),
  },
  {
    file: "src/app/api/admin/catalog/categories/route.ts",
    module: categoriesRoute,
    body: () => ({ name: "Vitamins", slug: `vitamins-${uniq()}` }),
  },
  {
    file: "src/app/api/admin/catalog/categories/[id]/route.ts",
    module: categoryRoute,
    id: seedCategory,
    body: () => ({ name: "Renamed" }),
  },
  {
    file: "src/app/api/admin/catalog/products/route.ts",
    module: productsRoute,
    body: () => ({ name: "Omega 3", currency: "USD", defaultMsrpMinor: 2999 }),
  },
  {
    file: "src/app/api/admin/catalog/products/[id]/route.ts",
    module: productRoute,
    id: seedProduct,
    body: () => ({ status: "active" }),
  },
  {
    file: "src/app/api/admin/catalog/skus/route.ts",
    module: skusRoute,
    body: () => ({
      catalogProductId: productId,
      sku: `X-${uniq()}`,
      baseCostMinor: "1250",
      currency: "USD",
    }),
  },
  {
    file: "src/app/api/admin/catalog/skus/[id]/route.ts",
    module: skuRoute,
    id: seedSku,
    body: () => ({ baseCostMinor: 150, currency: "USD" }),
  },
  {
    file: "src/app/api/admin/catalog/skus/[id]/costs/route.ts",
    module: skuCostsRoute,
    id: seedSku,
    body: () => ({
      fulfillmentCenterId: fcId,
      costMinor: 90,
      currency: "USD",
      effectiveFrom: "2026-01-01T00:00:00Z",
    }),
  },
];

/** Creates the rows that request bodies reference. */
export async function prepareAdminRoutes() {
  fcId = await seedFulfillmentCenter();
  productId = await seedProduct();
}
