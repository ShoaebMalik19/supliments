import { revalidatePath } from "next/cache";
import { adminOrNotFound } from "../guard";
import {
  listDeadLetters,
  listReviewQueue,
  resolveReviewItem,
  settleDeadLetter,
} from "@/modules/admin";

export const dynamic = "force-dynamic";

async function resolve(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  const status = form.get("status") === "dismissed" ? "dismissed" : "done";
  const note = String(form.get("note") ?? "").trim() || null;
  await resolveReviewItem(admin, String(form.get("id")), { status, note });
  revalidatePath("/admin/review");
}

async function settle(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  const id = String(form.get("id"));
  const action = form.get("action") === "discard" ? "discard" : "retry";
  await settleDeadLetter(
    admin,
    form.get("kind") === "notification"
      ? { kind: "notification", id }
      : { kind: "job", id, action },
  );
  revalidatePath("/admin/review");
}

const WHAT = {
  label_review: "Label waiting for approval",
  failed_fulfillment:
    "Fulfillment problem (unroutable, unknown partner status, stuck, push blocked)",
  address_hold: "Address problem",
  payment_hold: "Payment not recorded in time",
  claim: "Customer claim",
  integration_conflict: "Store already connected to another organization",
  privacy_request: "Customer privacy request (Shopify deadline: 30 days)",
} as const;

export default async function ReviewQueuePage() {
  const admin = await adminOrNotFound();
  const [items, dead] = await Promise.all([listReviewQueue(admin), listDeadLetters(admin)]);
  return (
    <main>
      <h1>Review queue ({items.length} open)</h1>
      <table>
        <thead>
          <tr>
            <th>Opened</th>
            <th>Type</th>
            <th>Organization</th>
            <th>Subject</th>
            <th>Resolve</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td>{i.createdAt.toISOString()}</td>
              <td>{WHAT[i.type]}</td>
              <td>{i.orgName ?? "platform"}</td>
              <td>
                {i.link ? <a href={i.link}>{i.entityType}</a> : i.entityType} {i.entityId}
              </td>
              <td>
                <form action={resolve}>
                  <input type="hidden" name="id" value={i.id} />
                  <input name="note" placeholder="What was done" />
                  <button type="submit" name="status" value="done">
                    Done
                  </button>
                  <button type="submit" name="status" value="dismissed">
                    Dismiss
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Dead jobs ({dead.jobs.length})</h2>
      <p>
        Background work that failed every attempt. Retry after fixing the cause (handlers are
        idempotent); discard only when the work is no longer wanted.
      </p>
      <table>
        <thead>
          <tr>
            <th>Last attempt</th>
            <th>Job</th>
            <th>Organization</th>
            <th>Attempts</th>
            <th>Last error</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {dead.jobs.map((j) => (
            <tr key={j.id}>
              <td>{j.updatedAt.toISOString()}</td>
              <td>{j.kind}</td>
              <td>{j.orgName ?? "platform"}</td>
              <td>{j.attempts}</td>
              <td>{j.lastError}</td>
              <td>
                <form action={settle}>
                  <input type="hidden" name="kind" value="job" />
                  <input type="hidden" name="id" value={j.id} />
                  <button type="submit" name="action" value="retry">
                    Retry
                  </button>
                  <button type="submit" name="action" value="discard">
                    Discard
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Undelivered emails ({dead.notifications.length})</h2>
      <table>
        <thead>
          <tr>
            <th>Last attempt</th>
            <th>Email</th>
            <th>Organization</th>
            <th>Attempts</th>
            <th>Last error</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {dead.notifications.map((n) => (
            <tr key={n.id}>
              <td>{n.updatedAt.toISOString()}</td>
              <td>{n.template}</td>
              <td>{n.orgName ?? "—"}</td>
              <td>{n.attempts}</td>
              <td>{n.lastError}</td>
              <td>
                <form action={settle}>
                  <input type="hidden" name="kind" value="notification" />
                  <input type="hidden" name="id" value={n.id} />
                  <button type="submit">Retry</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
