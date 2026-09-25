import { timingSafeEqual } from "node:crypto";
import { registerIntegrationJobs, scheduleReconciliation } from "@/modules/integrations";
import { drainJobs } from "@/modules/jobs";
import { registerFulfillmentJobs, scheduleStuckScan } from "@/modules/fulfillment";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.get("authorization") ?? "";
  const want = `Bearer ${secret}`;
  return (
    !!secret && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want))
  );
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Not found", { status: 404 });
  registerIntegrationJobs();
  registerFulfillmentJobs();
  const reconcileScheduled = await scheduleReconciliation();
  const stuckScanScheduled = await scheduleStuckScan();
  return Response.json({ ...(await drainJobs()), reconcileScheduled, stuckScanScheduled });
}
