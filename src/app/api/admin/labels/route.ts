import { adminRoute } from "@/modules/admin";
import { listLabelReviewQueue } from "@/modules/labels/admin";

export const GET = adminRoute(async (admin) => ({ queue: await listLabelReviewQueue(admin) }));
