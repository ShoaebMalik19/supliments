import { adminRoute } from "@/modules/admin";
import { approveLabel } from "@/modules/labels/admin";

export const POST = adminRoute<{ id: string }>((admin, _req, { id }) => approveLabel(admin, id));
