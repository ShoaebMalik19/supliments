import { adminRoute } from "@/modules/admin";
import { rejectLabel } from "@/modules/labels/admin";
import { readJson } from "@/lib/http";

export const POST = adminRoute<{ id: string }>(async (admin, req, { id }) =>
  rejectLabel(admin, id, await readJson(req)),
);
