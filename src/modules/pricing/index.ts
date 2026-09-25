import { and, desc, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { TenantDb } from "@/db/tenant";
import { feeSchedules } from "@/db/schema";
import { feeRulesSchema, type FeeRules } from "./calc";

export * from "./calc";

export type ActiveFeeSchedule = { id: string; version: number; currency: string; rules: FeeRules };

/** The fee schedule in force at `at` (highest version whose window contains it). */
export async function feeScheduleAt(
  t: TenantDb,
  at: Date = new Date(),
): Promise<ActiveFeeSchedule | null> {
  const [row] = await t.tx
    .select()
    .from(feeSchedules)
    .where(
      and(
        lte(feeSchedules.effectiveFrom, sql`${at.toISOString()}::timestamptz`),
        or(
          isNull(feeSchedules.effectiveTo),
          gt(feeSchedules.effectiveTo, sql`${at.toISOString()}::timestamptz`),
        ),
      ),
    )
    .orderBy(desc(feeSchedules.version))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    currency: row.currency,
    rules: feeRulesSchema.parse(row.rules),
  };
}
