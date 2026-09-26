import { revalidatePath } from "next/cache";
import { adminOrNotFound } from "../guard";
import { listReviewQueue, resolveReviewItem } from "@/modules/admin";

export const dynamic = "force-dynamic";

async function resolve(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  const status = form.get("status") === "dismissed" ? "dismissed" : "done";
  const note = String(form.get("note") ?? "").trim() || null;
  await resolveReviewItem(admin, String(form.get("id")), { status, note });
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
} as const;

export default async function ReviewQueuePage() {
  const admin = await adminOrNotFound();
  const items = await listReviewQueue(admin);
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
    </main>
  );
}
