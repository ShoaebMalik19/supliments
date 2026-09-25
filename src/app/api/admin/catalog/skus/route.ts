import { adminRoute } from "@/modules/admin";
import { createSku, listSkus } from "@/modules/catalog/admin";
import { json, readJson } from "@/lib/http";

export const GET = adminRoute(async (admin, req) => ({
  skus: await listSkus(admin, new URL(req.url).searchParams.get("productId")),
}));

export const POST = adminRoute(async (admin, req) =>
  json(await createSku(admin, await readJson(req)), { status: 201 }),
);
