import { scheduleReconciliation } from "@/modules/integrations";
import { scheduleStuckScan } from "@/modules/fulfillment";
import { cronAuthorized } from "@/lib/cron-auth";
import { drainQueue } from "@/queue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!(await cronAuthorized(req))) return new Response("Not found", { status: 404 });
  const reconcileScheduled = await scheduleReconciliation();
  const stuckScanScheduled = await scheduleStuckScan();
  const drained = await drainQueue({ budgetMs: 45_000 });
  return Response.json({ ...drained, reconcileScheduled, stuckScanScheduled });
}
