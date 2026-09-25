import { adminMarkOrderPaid, adminRoute } from "@/modules/admin";
import { readJson } from "@/lib/http";

export const POST = adminRoute<{ id: string }>(async (admin, req, { id }) =>
  adminMarkOrderPaid(admin, id, await readJson(req)),
);
