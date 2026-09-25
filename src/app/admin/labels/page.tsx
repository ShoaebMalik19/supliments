import { approveLabel, listLabelReviewQueue, rejectLabel } from "@/modules/labels/admin";
import { adminOrNotFound, formAction } from "../guard";

export const dynamic = "force-dynamic";

async function approve(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  await formAction("/admin/labels", () => approveLabel(admin, String(form.get("id"))));
}

async function reject(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  await formAction("/admin/labels", () =>
    rejectLabel(admin, String(form.get("id")), { reason: String(form.get("reason") ?? "") }),
  );
}

export default async function AdminLabelsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const admin = await adminOrNotFound();
  const { error } = await searchParams;
  const queue = await listLabelReviewQueue(admin);
  return (
    <main>
      <h1>Admin — label review queue</h1>
      <p>
        <a href="/admin">Organizations</a> · <a href="/admin/catalog">Catalog</a>
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {queue.length === 0 ? <p>Nothing to review.</p> : null}
      <table>
        <tbody>
          {queue.map((q) => (
            <tr key={q.reviewItemId}>
              <td>
                {q.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={q.previewUrl} alt={`Label ${q.label.id} preview`} width={300} />
                ) : (
                  "no preview"
                )}
              </td>
              <td>
                Org {q.orgId}
                <br />
                Label {q.label.id} v{q.label.version}
                <br />
                Submitted {new Date(q.openedAt).toISOString()}
              </td>
              <td>
                <form action={approve}>
                  <input type="hidden" name="id" value={q.label.id} />
                  <button type="submit">Approve</button>
                </form>
                <form action={reject}>
                  <input type="hidden" name="id" value={q.label.id} />
                  <input name="reason" placeholder="Rejection reason" required minLength={3} />
                  <button type="submit">Reject</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
