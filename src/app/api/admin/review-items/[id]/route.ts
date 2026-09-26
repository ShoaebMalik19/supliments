import { z } from "zod";
import { adminRoute, resolveReviewItem } from "@/modules/admin";
import { badRequest } from "@/lib/http";

const body = z.strictObject({
  status: z.enum(["done", "dismissed"]),
  note: z.string().trim().max(1000).optional(),
});

export const POST = adminRoute<{ id: string }>(async (admin, req, { id }) => {
  if (!z.uuid().safeParse(id).success) return null;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw badRequest();
  return resolveReviewItem(admin, id, {
    status: parsed.data.status,
    note: parsed.data.note ?? null,
  });
});
