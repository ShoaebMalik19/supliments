import { adminRoute } from "@/modules/admin";
import { createLabelTemplate } from "@/modules/labels/admin";
import { json, readJson } from "@/lib/http";

export const POST = adminRoute(async (admin, req) =>
  json(await createLabelTemplate(admin, await readJson(req)), { status: 201 }),
);
