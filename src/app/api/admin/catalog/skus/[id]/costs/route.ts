import { adminRoute } from "@/modules/admin";
import { createSkuCost, listSkuCosts } from "@/modules/catalog/admin";
import { json, readJson } from "@/lib/http";

type Params = { id: string };

export const GET = adminRoute<Params>(async (admin, _req, { id }) => {
  const costs = await listSkuCosts(admin, id);
  return costs && { costs };
});

export const POST = adminRoute<Params>(async (admin, req, { id }) => {
  const cost = await createSkuCost(admin, id, await readJson(req));
  return cost && json(cost, { status: 201 });
});
