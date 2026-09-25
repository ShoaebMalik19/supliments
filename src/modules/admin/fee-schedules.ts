import { and, desc, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { privilegedDb } from "@/db/privileged";
import { feeSchedules } from "@/db/schema";
import { jsonSafe, recordAudit } from "@/modules/audit";
import { feeRulesSchema } from "@/modules/pricing";
import { badRequest } from "@/lib/http";
import { currencyInput } from "@/lib/money";
import type { AdminContext } from "./index";

const feeScheduleCreate = z.strictObject({
  currency: currencyInput,
  effectiveFrom: z.coerce.date(),
  rules: feeRulesSchema,
});

export async function listFeeSchedules(_admin: AdminContext) {
  return privilegedDb().select().from(feeSchedules).orderBy(desc(feeSchedules.version));
}

/**
 * Appends fee schedule version max+1 effective from `effectiveFrom`, which must be later than the
 * newest version's start; any still-open schedule is closed at that instant. Existing charges keep
 * the schedule and amounts they were priced with.
 */
export async function createFeeSchedule(admin: AdminContext, raw: unknown) {
  const r = feeScheduleCreate.safeParse(raw);
  if (!r.success)
    throw badRequest(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const input = r.data;
  return privilegedDb().transaction(async (tx) => {
    await tx.execute(sql`lock table fee_schedules in share row exclusive mode`);
    const [latest] = await tx
      .select()
      .from(feeSchedules)
      .orderBy(desc(feeSchedules.version))
      .limit(1);
    if (latest && input.effectiveFrom <= latest.effectiveFrom)
      throw badRequest(
        `effectiveFrom must be after v${latest.version} (${latest.effectiveFrom.toISOString()})`,
      );
    const closed = await tx
      .update(feeSchedules)
      .set({ effectiveTo: input.effectiveFrom })
      .where(
        and(isNull(feeSchedules.effectiveTo), lt(feeSchedules.effectiveFrom, input.effectiveFrom)),
      )
      .returning({ id: feeSchedules.id, version: feeSchedules.version });
    const [created] = await tx
      .insert(feeSchedules)
      .values({
        version: (latest?.version ?? 0) + 1,
        currency: input.currency,
        rules: jsonSafe(input.rules),
        effectiveFrom: input.effectiveFrom,
      })
      .returning();
    await recordAudit(
      {
        orgId: null,
        actorUserId: admin.userId,
        actorType: "admin",
        action: "admin.fee_schedule_created",
        entityType: "fee_schedule",
        entityId: created!.id,
        before: { closed },
        after: created,
      },
      tx,
    );
    return created!;
  });
}
