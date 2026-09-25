import { completeUpload } from "@/modules/assets";
import { tenantRoute } from "@/modules/tenancy";

export const POST = tenantRoute<{ id: string }>("label:write", (ctx, t, _req, { id }) =>
  completeUpload(ctx, t, id),
);
