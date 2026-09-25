import { adminResolveOrder, adminRoute } from "@/modules/admin";

export const POST = adminRoute<{ id: string }>((admin, _req, { id }) =>
  adminResolveOrder(admin, id),
);
