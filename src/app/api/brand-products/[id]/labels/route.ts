import { findBrandProduct } from "@/modules/branding";
import { createLabelDraft, listLabels } from "@/modules/labels";
import { tenantRoute } from "@/modules/tenancy";
import { json, readJson } from "@/lib/http";

type Params = { id: string };

export const GET = tenantRoute<Params>("org:read", async (_ctx, t, _req, { id }) =>
  (await findBrandProduct(t, id)) ? { labels: await listLabels(t, id) } : null,
);

export const POST = tenantRoute<Params>("label:write", async (ctx, t, req, { id }) => {
  const label = await createLabelDraft(ctx, t, id, await readJson(req));
  return label && json(label, { status: 201 });
});
