import { registerFulfillmentJobs } from "@/modules/fulfillment";
import { registerIntegrationJobs } from "@/modules/integrations";
import { drainUntilEmpty } from "@/modules/jobs";

/**
 * Composition root for background work: the one place that knows every module's job handlers.
 * Used by the cron route (scheduled backstop) and by `kickQueue()` (right after a request).
 */
export function registerAllJobs() {
  registerIntegrationJobs();
  registerFulfillmentJobs();
}

export async function drainQueue(opts: { budgetMs?: number } = {}) {
  registerAllJobs();
  return drainUntilEmpty(opts);
}
