import { adminRoute, createFeeSchedule, listFeeSchedules } from "@/modules/admin";
import { json, readJson } from "@/lib/http";

export const GET = adminRoute(async (admin) => ({
  feeSchedules: await listFeeSchedules(admin),
}));

export const POST = adminRoute(async (admin, req) =>
  json(await createFeeSchedule(admin, await readJson(req)), { status: 201 }),
);
