import { adminRoute } from "@/modules/admin";
import { updateCategory } from "@/modules/catalog/admin";
import { readJson } from "@/lib/http";

export const PATCH = adminRoute<{ id: string }>(async (admin, req, { id }) =>
  updateCategory(admin, id, await readJson(req)),
);
