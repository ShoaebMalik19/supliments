import { adminRoute } from "@/modules/admin";
import { createCategory, listCategories } from "@/modules/catalog/admin";
import { json, readJson } from "@/lib/http";

export const GET = adminRoute(async (admin) => ({ categories: await listCategories(admin) }));

export const POST = adminRoute(async (admin, req) =>
  json(await createCategory(admin, await readJson(req)), { status: 201 }),
);
