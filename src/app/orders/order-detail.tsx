import type { getOrder } from "@/modules/orders";
import { formatMinor } from "@/lib/format";

type Detail = NonNullable<Awaited<ReturnType<typeof getOrder>>>;

const money = (amount: bigint | null, currency: string) =>
  amount === null ? "—" : formatMinor(amount, currency);

export function OrderDetail({ detail }: { detail: Detail }) {
  const { order, items, charge, ledger, timeline } = detail;
  return (
    <>
      <p>
        Status: {order.status}
        {order.holdReason ? ` (${order.holdReason})` : ""}
      </p>
      <p>Retail total: {money(order.retailTotalMinor, order.currency)}</p>
      <h2>Items</h2>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Qty</th>
            <th>Retail unit</th>
            <th>Our unit cost</th>
            <th>Fulfillment fee</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td>{i.skuId ?? "unresolved"}</td>
              <td>{i.quantity}</td>
              <td>{money(i.retailUnitPriceMinor, i.currency)}</td>
              <td>{money(i.costUnitMinor, i.currency)}</td>
              <td>{money(i.fulfillmentFeeMinor, i.currency)}</td>
              <td>{i.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Charge</h2>
      {charge ? (
        <p>
          {money(charge.amountMinor, charge.currency)} — {charge.status}
          {charge.markedPaidAt ? ` (paid ${charge.markedPaidAt.toISOString()})` : ""}
        </p>
      ) : (
        <p>Not priced yet.</p>
      )}
      {ledger.currency && (
        <table>
          <tbody>
            {Object.entries(ledger.byAccount).map(([account, amount]) => (
              <tr key={account}>
                <td>{account}</td>
                <td>{money(amount, ledger.currency!)}</td>
              </tr>
            ))}
            <tr>
              <td>Outstanding</td>
              <td>{money(ledger.balanceMinor, ledger.currency)}</td>
            </tr>
          </tbody>
        </table>
      )}
      <h2>Timeline</h2>
      <ol>
        {timeline.map((e) => (
          <li key={e.id}>
            {e.createdAt.toISOString()} — {e.type}
            {e.toStatus ? `: ${e.fromStatus ?? "∅"} → ${e.toStatus}` : ""} ({e.actorType})
          </li>
        ))}
      </ol>
    </>
  );
}
