import { revalidatePath } from "next/cache";
import { adminOrNotFound } from "../guard";
import { createDispatchBatch, importDispatchResults, listBatches } from "@/modules/fulfillment";

export const dynamic = "force-dynamic";

async function createBatch(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  await createDispatchBatch(admin.userId, String(form.get("fulfillmentCenterId")));
  revalidatePath("/admin/dispatch");
}

async function importSheet(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return;
  await importDispatchResults(
    admin.userId,
    String(form.get("batchId")),
    new Uint8Array(await file.arrayBuffer()),
  );
  revalidatePath("/admin/dispatch");
}

export default async function DispatchPage() {
  await adminOrNotFound();
  const batches = await listBatches();
  return (
    <main>
      <h1>Dispatch batches</h1>
      <form action={createBatch}>
        <label>
          Fulfillment center id <input name="fulfillmentCenterId" required />
        </label>
        <button type="submit">Create batch from pending orders</button>
      </form>
      <table>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id}>
              <td>{b.id}</td>
              <td>{b.status}</td>
              <td>{b.rowCount} rows</td>
              <td>
                <a href={`/api/admin/dispatch-batches/${b.id}/file`}>Download</a>
              </td>
              <td>
                <form action={importSheet}>
                  <input type="hidden" name="batchId" value={b.id} />
                  <input type="file" name="file" accept=".csv,text/csv" required />
                  <button type="submit">Import completed sheet</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
