import { getOrder } from "@/modules/orders";
import { tenantRoute } from "@/modules/tenancy";

export const GET = tenantRoute<{ id: string }>("org:read", (_ctx, t, _req, { id }) =>
  getOrder(t, id),
);
