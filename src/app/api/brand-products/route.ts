import { createBrandProduct, listBrandProducts } from "@/modules/branding";
import { tenantRoute } from "@/modules/tenancy";
import { json } from "@/lib/http";

export const GET = tenantRoute("org:read", async (_ctx, t) => ({
  brandProducts: await listBrandProducts(t),
}));

export const POST = tenantRoute("brand:write", async (ctx, t, req) =>
  json(await createBrandProduct(ctx, t, await req.json().catch(() => null)), { status: 201 }),
);
