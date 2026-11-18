import { brands } from "@/db/schema";
import { renameBrand } from "@/modules/branding";
import { tenantRoute } from "@/modules/tenancy";

type Params = { id: string };

export const GET = tenantRoute<Params>("org:read", (_ctx, t, _req, { id }) => t.find(brands, id));

export const PATCH = tenantRoute<Params>("brand:write", async (ctx, t, req, { id }) =>
  renameBrand(ctx, t, id, await req.json().catch(() => null)),
);
