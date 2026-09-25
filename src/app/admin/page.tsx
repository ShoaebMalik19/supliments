import { revalidatePath } from "next/cache";
import { listOrganizations, setOrganizationStatus } from "@/modules/admin";
import { adminOrNotFound } from "./guard";

export const dynamic = "force-dynamic";

async function toggleStatus(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  const status = form.get("status") === "suspended" ? "suspended" : "active";
  await setOrganizationStatus(admin, String(form.get("orgId")), status);
  revalidatePath("/admin");
}

export default async function AdminPage() {
  const admin = await adminOrNotFound();
  const orgs = await listOrganizations(admin);
  return (
    <main>
      <h1>Admin — organizations</h1>
      <p>
        <a href="/admin/catalog">Catalog</a> · <a href="/admin/labels">Label reviews</a>
      </p>
      <table>
        <tbody>
          {orgs.map((o) => (
            <tr key={o.id}>
              <td>{o.name}</td>
              <td>{o.status}</td>
              <td>
                <form action={toggleStatus}>
                  <input type="hidden" name="orgId" value={o.id} />
                  <input
                    type="hidden"
                    name="status"
                    value={o.status === "suspended" ? "active" : "suspended"}
                  />
                  <button type="submit">
                    {o.status === "suspended" ? "Reactivate" : "Suspend"}
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
