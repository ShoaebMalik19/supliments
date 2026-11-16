import { registerFulfillmentJobs } from "@/modules/fulfillment";
import { registerIntegrationJobs } from "@/modules/integrations";
import { drainUntilEmpty } from "@/modules/jobs";
import { publishOutbox, sendPendingNotifications } from "@/modules/notifications";

/**
 * Composition root for background work: the one place that knows every module's job handlers.
 * Used by the cron route (scheduled backstop) and by `kickQueue()` (right after a request).
 */
export function registerAllJobs() {
  registerIntegrationJobs();
  registerFulfillmentJobs();
}

/** Jobs first, then the events they produced become emails, within one time budget. */
export async function drainQueue(opts: { budgetMs?: number } = {}) {
  registerAllJobs();
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  const jobs = await drainUntilEmpty({
    budgetMs: Math.max(1_000, (opts.budgetMs ?? 45_000) * 0.8),
  });
  const outbox = await publishOutbox();
  const email = await sendPendingNotifications({ deadline });
  return { ...jobs, outbox, email };
}
