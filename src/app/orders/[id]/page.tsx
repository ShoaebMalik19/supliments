import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { withTenant } from "@/db/tenant";
import { getOrder } from "@/modules/orders";
import { orderShipments } from "@/modules/fulfillment";
import { resolveTenant } from "@/modules/tenancy";
import { OrderDetail } from "../order-detail";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveTenant();
  if (!ctx) redirect("/login");
  const { id } = await params;
  const found = await withTenant(ctx.orgId, async (t) => {
    const detail = await getOrder(t, id);
    return detail && { detail, shipments: await orderShipments(t, id) };
  });
  if (!found) notFound();
  const { detail, shipments } = found;
  return (
    <main>
      <p>
        <Link href="/orders">Orders</Link>
      </p>
      <h1>Order {detail.order.externalOrderNumber ?? detail.order.id}</h1>
      <OrderDetail detail={detail} />
      <h2>Shipments</h2>
      <ul>
        {shipments.map((s) => (
          <li key={s.id}>
            {s.carrier} {s.trackingNumber} {s.trackingUrl && <a href={s.trackingUrl}>track</a>} —{" "}
            {s.pushedToStoreAt ? "sent to store" : "not yet sent to store"}
          </li>
        ))}
      </ul>
    </main>
  );
}
