import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import type { TenantDb } from "@/db/tenant";
import { reviewQueueItems } from "@/db/schema";
import { reviewItemType } from "@/db/schema/enums";

export type ReviewItemType = (typeof reviewItemType.enumValues)[number];

const OPEN = ["open", "in_progress"] as const;

/**
 * Opens a review item in the tenant's own transaction so it commits with the state change.
 * A partial unique index allows one open item per (type, entity).
 */
export async function openReviewItem(
  t: TenantDb,
  input: { type: ReviewItemType; entityType: string; entityId: string; priority?: number },
) {
  return t.insert(reviewQueueItems, input);
}

export async function closeReviewItem(
  type: ReviewItemType,
  entityId: string,
  status: "done" | "dismissed" = "done",
) {
  const rows = await privilegedDb()
    .update(reviewQueueItems)
    .set({ status })
    .where(
      and(
        eq(reviewQueueItems.type, type),
        eq(reviewQueueItems.entityId, entityId),
        inArray(reviewQueueItems.status, [...OPEN]),
      ),
    )
    .returning({ id: reviewQueueItems.id });
  return rows.length;
}

export async function listOpenReviewItems(type: ReviewItemType, limit = 200) {
  return privilegedDb()
    .select()
    .from(reviewQueueItems)
    .where(and(eq(reviewQueueItems.type, type), inArray(reviewQueueItems.status, [...OPEN])))
    .orderBy(desc(reviewQueueItems.priority), asc(reviewQueueItems.createdAt))
    .limit(limit);
}
