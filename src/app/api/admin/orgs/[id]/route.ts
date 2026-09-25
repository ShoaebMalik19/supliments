import { z } from "zod";
import { adminRoute, setOrganizationStatus } from "@/modules/admin";
import { badRequest } from "@/lib/http";

const UUID = z.string().uuid();
const patch = z.object({ status: z.enum(["active", "suspended"]) });

export const PATCH = adminRoute<{ id: string }>(async (admin, req, { id }) => {
  if (!UUID.safeParse(id).success) return null;
  const body = patch.safeParse(await req.json().catch(() => null));
  if (!body.success) throw badRequest();
  return setOrganizationStatus(admin, id, body.data.status);
});
