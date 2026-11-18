import { adminSearchOrders } from "@/modules/admin";
import { orderStatus } from "@/db/schema/enums";
import { formatMinor } from "@/lib/format";
import { adminOrNotFound } from "../guard";

export const dynamic = "force-dynamic";

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const admin = await adminOrNotFound();
  const sp = await searchParams;
  const status = (orderStatus.enumValues as readonly string[]).includes(sp.status ?? "")
    ? sp.status
    : undefined;
  const q = (sp.q ?? "").slice(0, 100);
  const rows = await adminSearchOrders(admin, { q, status });
  return (
    <main>
      <h1>Orders</h1>
      <form method="get">
        <input name="q" defaultValue={q} placeholder="Order number, order id or organization" />
        <select name="status" defaultValue={status ?? ""}>
          <option value="">Any status</option>
          {orderStatus.enumValues.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit">Search</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Organization</th>
            <th>Status</th>
            <th>Retail total</th>
            <th>Placed</th>
            <th>Last change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td>
                <a href={`/admin/orders/${o.id}`}>{o.number ?? o.id}</a>
              </td>
              <td>{o.orgName}</td>
              <td>{o.status}</td>
              <td>{formatMinor(o.retailTotalMinor, o.currency)}</td>
              <td>{o.placedAt?.toISOString() ?? ""}</td>
              <td>{o.updatedAt.toISOString()}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6}>No orders match.</td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
