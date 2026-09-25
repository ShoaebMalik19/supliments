import { orderShipments } from "@/modules/fulfillment";
import { getOrder } from "@/modules/orders";
import { tenantRoute } from "@/modules/tenancy";

export const GET = tenantRoute<{ id: string }>("org:read", async (_ctx, t, _req, { id }) => {
  const order = await getOrder(t, id);
  return order && { ...order, shipments: await orderShipments(t, id) };
});
