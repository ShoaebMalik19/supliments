import { listActiveProducts } from "@/modules/catalog";
import { tenantRoute } from "@/modules/tenancy";

export const GET = tenantRoute("org:read", async (_ctx, t) => ({
  products: await listActiveProducts(t),
}));
