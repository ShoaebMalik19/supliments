export const TEMPLATES = [
  "order_received",
  "order_action_required",
  "order_shipped",
  "label_approved",
  "label_rejected",
] as const;
export type Template = (typeof TEMPLATES)[number];

export type OutboxLike = { eventType: string; payload: unknown };

type P = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
/** One line, no control characters: values come from stores and brand owners. */
const clean = (v: unknown, max = 200) =>
  (str(v) ?? (typeof v === "number" ? String(v) : ""))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** Which email, if any, an outbox event produces. Everything else is published silently. */
export function templateFor(e: OutboxLike): Template | null {
  const p = (e.payload ?? {}) as P;
  if (e.eventType === "label.approved") return "label_approved";
  if (e.eventType === "label.rejected") return "label_rejected";
  if (e.eventType !== "order.status_changed") return null;
  if (p.to === "awaiting_payment" && p.from !== "awaiting_payment") return "order_received";
  if (p.to === "needs_review" || p.to === "on_hold") return "order_action_required";
  if (p.to === "shipped") return "order_shipped";
  return null;
}

export function renderEmail(template: Template, payload: unknown, siteUrl: string) {
  const p = (payload ?? {}) as P;
  const d = (p.details ?? {}) as P;
  const base = siteUrl.replace(/\/$/, "");
  const order = clean(p.orderNumber, 40) || "your order";
  const orderUrl = `${base}/orders/${clean(p.orderId, 40)}`;
  const labelUrl = `${base}/labels/${clean(p.labelId, 40)}`;
  const product = clean(p.productTitle, 120) || "your product";
  switch (template) {
    case "order_received":
      return {
        subject: `Order ${order} received`,
        text: `We received order ${order} from your store and priced it.\n\nIt is waiting for payment confirmation before it goes to production.\n\n${orderUrl}`,
      };
    case "order_action_required":
      return {
        subject: `Action needed on order ${order}`,
        text: `Order ${order} is on hold and will not be produced until it is resolved.\n\nReason: ${clean(p.holdReason) || "needs review"}\n\n${orderUrl}`,
      };
    case "order_shipped":
      return {
        subject: `Order ${order} shipped`,
        text: `Order ${order} has shipped.\n\nCarrier: ${clean(d.carrier, 60) || "n/a"}\nTracking: ${clean(d.trackingNumber, 80) || "n/a"}\n\nTracking is also sent to your store, which notifies your customer.\n\n${orderUrl}`,
      };
    case "label_approved":
      return {
        subject: `Label approved for ${product}`,
        text: `Version ${clean(p.version, 6)} of the label for ${product} is approved. The print file is frozen and the product can be published to your store.\n\n${labelUrl}`,
      };
    case "label_rejected":
      return {
        subject: `Label needs changes for ${product}`,
        text: `The label for ${product} was not approved.\n\nReason: ${clean(p.reason, 500) || "see the label page"}\n\nEdit the label and submit it again.\n\n${labelUrl}`,
      };
  }
}
