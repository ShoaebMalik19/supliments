import { adminRoute } from "@/modules/admin";
import { updateSku } from "@/modules/catalog/admin";
import { readJson } from "@/lib/http";

export const PATCH = adminRoute<{ id: string }>(async (admin, req, { id }) =>
  updateSku(admin, id, await readJson(req)),
);
