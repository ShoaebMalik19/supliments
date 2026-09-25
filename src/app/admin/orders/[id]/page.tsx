import { notFound } from "next/navigation";
import { adminGetOrder, adminMarkOrderPaid, adminResolveOrder } from "@/modules/admin";
import { OrderDetail } from "../../../orders/order-detail";
import { adminOrNotFound, formAction, formFields } from "../../guard";

export const dynamic = "force-dynamic";

const pathFor = (id: string) => `/admin/orders/${id}`;

async function markPaid(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  const id = String(form.get("id"));
  await formAction(pathFor(id), () =>
    adminMarkOrderPaid(admin, id, formFields(form, ["reference", "note"])),
  );
}

async function resolve(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  const id = String(form.get("id"));
  await formAction(pathFor(id), () => adminResolveOrder(admin, id));
}

export default async function AdminOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const admin = await adminOrNotFound();
  const { id } = await params;
  const { error } = await searchParams;
  const detail = await adminGetOrder(admin, id);
  if (!detail) notFound();
  const { order, charge } = detail;
  return (
    <main>
      <h1>Order {order.externalOrderNumber ?? order.id}</h1>
      <p>Org: {detail.orgId}</p>
      {error && <p role="alert">{error}</p>}
      {order.status === "awaiting_payment" && charge && charge.status !== "succeeded" && (
        <form action={markPaid}>
          <input type="hidden" name="id" value={order.id} />
          <label>
            Payment reference <input name="reference" required />
          </label>
          <label>
            Note <input name="note" />
          </label>
          <button type="submit">Mark paid</button>
        </form>
      )}
      {order.status === "needs_review" && (
        <form action={resolve}>
          <input type="hidden" name="id" value={order.id} />
          <button type="submit">Re-run line resolution and pricing</button>
        </form>
      )}
      <OrderDetail detail={detail} />
    </main>
  );
}
