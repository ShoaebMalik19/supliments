import { redirect } from "next/navigation";
import { withTenant } from "@/db/tenant";
import { listOrders } from "@/modules/orders";
import { resolveTenant } from "@/modules/tenancy";
import { formatMinor } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const ctx = await resolveTenant();
  if (!ctx) redirect("/login");
  const rows = await withTenant(ctx.orgId, (t) => listOrders(t));
  return (
    <main>
      <h1>Orders</h1>
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Status</th>
            <th>Retail total</th>
            <th>Placed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td>
                <a href={`/orders/${o.id}`}>{o.externalOrderNumber ?? o.id}</a>
              </td>
              <td>{o.status}</td>
              <td>{formatMinor(o.retailTotalMinor, o.currency)}</td>
              <td>{o.placedAt?.toISOString() ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
