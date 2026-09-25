import { z } from "zod";
import { registerJob } from "@/modules/jobs";
import { JOB_PROCESS_WEBHOOK, JOB_PUBLISH_PRODUCT, JOB_RECONCILE } from "./privileged";
import { runPublishJob } from "./publish";
import { runReconcileJob, runWebhookJob } from "./sync";

const requireOrg = (orgId: string | null) => {
  if (!orgId) throw new Error("integration job without org");
  return orgId;
};

const webhookPayload = z.object({
  webhookEventId: z.uuid(),
  kind: z.enum(["order", "app_uninstalled", "other"]),
});
const integrationPayload = z.object({ integrationId: z.uuid() });
const publishPayload = z.object({ brandProductId: z.uuid(), integrationId: z.uuid() });

export function registerIntegrationJobs() {
  registerJob(JOB_PROCESS_WEBHOOK, async (payload, job) => {
    await runWebhookJob(requireOrg(job.orgId), webhookPayload.parse(payload));
  });
  registerJob(JOB_RECONCILE, async (payload, job) => {
    await runReconcileJob(requireOrg(job.orgId), integrationPayload.parse(payload));
  });
  registerJob(JOB_PUBLISH_PRODUCT, async (payload, job) => {
    await runPublishJob(requireOrg(job.orgId), publishPayload.parse(payload));
  });
}
