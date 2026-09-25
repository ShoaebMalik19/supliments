import { z } from "zod";
import { adminRoute } from "@/modules/admin";
import { readAssetObject } from "@/modules/assets";
import { batchFile } from "@/modules/fulfillment";
import { recordAudit } from "@/modules/audit";

export const GET = adminRoute<{ id: string }>(async (admin, _req, { id }) => {
  if (!z.uuid().safeParse(id).success) return null;
  const found = await batchFile(id);
  if (!found) return null;
  const data = await readAssetObject(found.asset);
  if (!data) return null;
  await recordAudit({
    orgId: null,
    actorUserId: admin.userId,
    actorType: "admin",
    action: "admin.dispatch_batch_downloaded",
    entityType: "dispatch_batch",
    entityId: id,
  });
  const name = found.asset.storageKey.split("/").pop() ?? `dispatch-${id}`;
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": found.asset.mime,
      "content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
      "cache-control": "no-store",
    },
  });
});
