import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { notifications, outboxEvents } from "@/db/schema";
import { orgAdminRecipients, userEmail } from "@/modules/tenancy";
import { emailProvider } from "./email";
import { renderEmail, templateFor, TEMPLATES, type Template } from "./templates";

export {
  setEmailProviderForTests,
  emailProvider,
  type EmailProvider,
  type EmailMessage,
} from "./email";
export { renderEmail, templateFor, TEMPLATES, type Template } from "./templates";

export const MAX_SEND_ATTEMPTS = 5;

/**
 * Outbox → notifications. Each unpublished event becomes one pending email per org owner/admin,
 * exactly once (dedupe key = event id + user), in the same transaction that marks it published.
 */
export async function publishOutbox(opts: { limit?: number } = {}) {
  let published = 0;
  let created = 0;
  for (let i = 0; i < (opts.limit ?? 100); i++) {
    const done = await privilegedDb().transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.publishedAt))
        .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!event) return false;
      const template = templateFor(event);
      if (template && event.orgId) {
        for (const r of await orgAdminRecipients(event.orgId)) {
          const rows = await tx
            .insert(notifications)
            .values({
              orgId: event.orgId,
              userId: r.userId,
              channel: "email",
              template,
              payload: event.payload,
              dedupeKey: `${event.id}:${r.userId}`,
            })
            .onConflictDoNothing({ target: notifications.dedupeKey })
            .returning({ id: notifications.id });
          created += rows.length;
        }
      }
      await tx
        .update(outboxEvents)
        .set({ publishedAt: new Date(), attempts: sql`${outboxEvents.attempts} + 1` })
        .where(eq(outboxEvents.id, event.id));
      return true;
    });
    if (!done) break;
    published++;
  }
  return { published, created };
}

const isTemplate = (t: string): t is Template => (TEMPLATES as readonly string[]).includes(t);

/**
 * Delivers pending emails one at a time, each in its own transaction with the row locked. A
 * failed send stays pending and is retried on the next run; after MAX_SEND_ATTEMPTS it is marked
 * failed. With no provider configured nothing is sent and nothing is lost.
 */
export async function sendPendingNotifications(opts: { limit?: number; deadline?: number } = {}) {
  const provider = emailProvider();
  const summary = { configured: !!provider, sent: 0, failed: 0, retrying: 0 };
  if (!provider) return summary;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const skip: string[] = [];
  for (let i = 0; i < (opts.limit ?? 50); i++) {
    if (opts.deadline && Date.now() >= opts.deadline) break;
    const outcome = await privilegedDb().transaction(async (tx) => {
      const [n] = await tx
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.status, "pending"),
            eq(notifications.channel, "email"),
            skip.length ? notInArray(notifications.id, skip) : undefined,
          ),
        )
        .orderBy(asc(notifications.createdAt), asc(notifications.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!n) return null;
      const fail = async (error: string) => {
        const attempts = n.attempts + 1;
        const dead = attempts >= MAX_SEND_ATTEMPTS;
        await tx
          .update(notifications)
          .set({ attempts, lastError: error.slice(0, 300), status: dead ? "failed" : "pending" })
          .where(eq(notifications.id, n.id));
        skip.push(n.id);
        return dead ? ("failed" as const) : ("retrying" as const);
      };
      const to = n.userId ? await userEmail(n.userId) : null;
      if (!to || !isTemplate(n.template))
        return fail(!to ? "recipient has no email" : "unknown template");
      try {
        const { subject, text } = renderEmail(n.template, n.payload, siteUrl);
        await provider.send({ to, subject, text, idempotencyKey: `notification-${n.id}` });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      await tx
        .update(notifications)
        .set({ status: "sent", sentAt: new Date(), attempts: n.attempts + 1, lastError: null })
        .where(eq(notifications.id, n.id));
      return "sent" as const;
    });
    if (!outcome) break;
    summary[outcome]++;
  }
  return summary;
}

export async function pendingNotificationCount() {
  const [r] = await privilegedDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(eq(notifications.status, "pending"));
  return r!.n;
}
