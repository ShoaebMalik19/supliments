import { downloadUrl } from "@/modules/assets";
import { tenantRoute } from "@/modules/tenancy";

export const GET = tenantRoute<{ id: string }>("org:read", (_ctx, t, _req, { id }) =>
  downloadUrl(t, id),
);
