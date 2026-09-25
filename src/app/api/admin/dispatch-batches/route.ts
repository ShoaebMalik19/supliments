import { z } from "zod";
import { adminRoute } from "@/modules/admin";
import { createDispatchBatch, listBatches } from "@/modules/fulfillment";
import { badRequest, HttpError, json } from "@/lib/http";

export const GET = adminRoute(async () => ({ batches: await listBatches() }));

const body = z.strictObject({ fulfillmentCenterId: z.uuid() });

export const POST = adminRoute(async (admin, req) => {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw badRequest();
  const batch = await createDispatchBatch(admin.userId, parsed.data.fulfillmentCenterId);
  if (batch === "empty") throw new HttpError(409, "Nothing ready to dispatch for this center");
  return batch && json(batch, { status: 201 });
});
