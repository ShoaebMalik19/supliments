import { adminGetOrder, adminRoute } from "@/modules/admin";

export const GET = adminRoute<{ id: string }>((admin, _req, { id }) => adminGetOrder(admin, id));
