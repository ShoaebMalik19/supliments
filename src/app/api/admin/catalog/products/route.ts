import { adminRoute } from "@/modules/admin";
import { createProduct, listProducts } from "@/modules/catalog/admin";
import { json, readJson } from "@/lib/http";

export const GET = adminRoute(async (admin) => ({ products: await listProducts(admin) }));

export const POST = adminRoute(async (admin, req) =>
  json(await createProduct(admin, await readJson(req)), { status: 201 }),
);
