import { requestPublish } from "@/modules/integrations";
import { tenantRoute } from "@/modules/tenancy";
import { readJson } from "@/lib/http";

type Params = { id: string };

export const POST = tenantRoute<Params>("brand:write", async (ctx, t, req, { id }) =>
  requestPublish(ctx, t, id, await readJson(req)),
);
