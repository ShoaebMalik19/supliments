import { adminRoute, listReviewQueue } from "@/modules/admin";

export const GET = adminRoute(async (admin) => ({ items: await listReviewQueue(admin) }));
