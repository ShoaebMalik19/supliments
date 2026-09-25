import { startShopifyInstall } from "@/modules/integrations";
import { tenantRoute } from "@/modules/tenancy";

export const dynamic = "force-dynamic";

export const GET = tenantRoute("org:update", (ctx, t, req) => startShopifyInstall(ctx, t, req));
