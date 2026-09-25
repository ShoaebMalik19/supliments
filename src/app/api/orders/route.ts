import { listOrders } from "@/modules/orders";
import { tenantRoute } from "@/modules/tenancy";

export const GET = tenantRoute("org:read", async (_ctx, t) => ({ orders: await listOrders(t) }));
