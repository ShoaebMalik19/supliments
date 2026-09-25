import { getBrandProduct, updateBrandProduct } from "@/modules/branding";
import { tenantRoute } from "@/modules/tenancy";

type Params = { id: string };

export const GET = tenantRoute<Params>("org:read", (_ctx, t, _req, { id }) =>
  getBrandProduct(t, id),
);

export const PATCH = tenantRoute<Params>("brand:write", async (ctx, t, req, { id }) =>
  updateBrandProduct(ctx, t, id, await req.json().catch(() => null)),
);
