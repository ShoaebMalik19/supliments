import { disconnectIntegration } from "@/modules/integrations";
import { tenantRoute } from "@/modules/tenancy";

export const POST = tenantRoute<{ id: string }>("org:update", (ctx, t, _req, { id }) =>
  disconnectIntegration(ctx, t, id),
);
