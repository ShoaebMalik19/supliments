import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { withTenant } from "@/db/tenant";
import { getOrder } from "@/modules/orders";
import { resolveTenant } from "@/modules/tenancy";
import { OrderDetail } from "../order-detail";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveTenant();
  if (!ctx) redirect("/login");
  const { id } = await params;
  const detail = await withTenant(ctx.orgId, (t) => getOrder(t, id));
  if (!detail) notFound();
  return (
    <main>
      <p>
        <Link href="/orders">Orders</Link>
      </p>
      <h1>Order {detail.order.externalOrderNumber ?? detail.order.id}</h1>
      <OrderDetail detail={detail} />
    </main>
  );
}
