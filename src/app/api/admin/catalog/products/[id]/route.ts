import { adminRoute } from "@/modules/admin";
import { getProduct, updateProduct } from "@/modules/catalog/admin";
import { readJson } from "@/lib/http";

type Params = { id: string };

export const GET = adminRoute<Params>((admin, _req, { id }) => getProduct(admin, id));

export const PATCH = adminRoute<Params>(async (admin, req, { id }) =>
  updateProduct(admin, id, await readJson(req)),
);
