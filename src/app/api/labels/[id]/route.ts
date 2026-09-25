import { getLabel, updateLabelDesign } from "@/modules/labels";
import { tenantRoute } from "@/modules/tenancy";
import { json, readJson } from "@/lib/http";

type Params = { id: string };

export const GET = tenantRoute<Params>("org:read", (_ctx, t, _req, { id }) => getLabel(t, id));

export const PATCH = tenantRoute<Params>("label:write", async (ctx, t, req, { id }) => {
  const out = await updateLabelDesign(ctx, t, id, await readJson(req));
  return out && json(out.label, { status: out.created ? 201 : 200 });
});
