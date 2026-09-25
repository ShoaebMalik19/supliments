import { submitLabel } from "@/modules/labels";
import { tenantRoute } from "@/modules/tenancy";

export const POST = tenantRoute<{ id: string }>("label:write", (ctx, t, _req, { id }) =>
  submitLabel(ctx, t, id),
);
