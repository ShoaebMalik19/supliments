import { listIntegrations } from "@/modules/integrations";
import { tenantRoute } from "@/modules/tenancy";

export const GET = tenantRoute("org:read", async (_ctx, t) => ({
  integrations: await listIntegrations(t),
}));
