import { createUpload } from "@/modules/assets";
import { tenantRoute } from "@/modules/tenancy";
import { readJson } from "@/lib/http";

export const POST = tenantRoute("label:write", async (ctx, t, req) =>
  createUpload(ctx, t, await readJson(req)),
);
