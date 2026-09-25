import { getActiveProduct } from "@/modules/catalog";
import { tenantRoute } from "@/modules/tenancy";

export const GET = tenantRoute<{ id: string }>("org:read", (_ctx, t, _req, { id }) =>
  getActiveProduct(t, id),
);
