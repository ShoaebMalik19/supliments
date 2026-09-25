import { createBrand, listBrands } from "@/modules/branding";
import { tenantRoute } from "@/modules/tenancy";
import { json } from "@/lib/http";

export const GET = tenantRoute("org:read", async (_ctx, t) => ({ brands: await listBrands(t) }));

export const POST = tenantRoute("brand:write", async (ctx, t, req) =>
  json(await createBrand(ctx, t, await req.json().catch(() => null)), { status: 201 }),
);
