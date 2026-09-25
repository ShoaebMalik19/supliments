import { z } from "zod";
import { adminRoute } from "@/modules/admin";
import { importDispatchResults } from "@/modules/fulfillment";
import { HttpError } from "@/lib/http";

const MAX_BYTES = 5 * 1024 * 1024;

/** Body is the partner's completed file, as sent (e.g. text/csv). */
export const POST = adminRoute<{ id: string }>(async (admin, req, { id }) => {
  if (!z.uuid().safeParse(id).success) return null;
  const data = new Uint8Array(await req.arrayBuffer());
  if (data.length === 0) throw new HttpError(400, "Empty file");
  if (data.length > MAX_BYTES) throw new HttpError(413, "File too large");
  return importDispatchResults(admin.userId, id, data);
});
