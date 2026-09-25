import { z } from "zod";
import { externalOrderSchema, type ExternalOrder } from "@/modules/orders/external";
import { decimalToMinor } from "./money";

const id = z.union([z.number(), z.string()]).transform(String);
const amount = z.union([z.string(), z.number()]).nullish();

const address = z
  .object({
    name: z.string().nullish(),
    company: z.string().nullish(),
    address1: z.string().nullish(),
    address2: z.string().nullish(),
    city: z.string().nullish(),
    province: z.string().nullish(),
    zip: z.string().nullish(),
    country_code: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .nullish();

export const shopifyOrder = z.object({
  id,
  name: z.string().nullish(),
  currency: z.string(),
  created_at: z.string().nullish(),
  processed_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  financial_status: z.string().nullish(),
  cancelled_at: z.string().nullish(),
  test: z.boolean().nullish(),
  email: z.string().nullish(),
  customer: z
    .object({
      id: id.nullish(),
      email: z.string().nullish(),
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
      phone: z.string().nullish(),
    })
    .nullish(),
  shipping_address: address,
  billing_address: address,
  subtotal_price: amount,
  total_price: amount,
  total_shipping_price_set: z.object({ shop_money: z.object({ amount }).nullish() }).nullish(),
  line_items: z.array(
    z.object({
      id,
      variant_id: id.nullish(),
      sku: z.string().nullish(),
      title: z.string().nullish(),
      name: z.string().nullish(),
      quantity: z.number().int(),
      current_quantity: z.number().int().nullish(),
      price: amount,
    }),
  ),
});

const FINANCIAL = ["pending", "paid", "partially_paid", "refunded", "voided"] as const;

const addr = (a: z.output<typeof address>) =>
  a
    ? {
        name: a.name ?? null,
        company: a.company ?? null,
        address1: a.address1 ?? null,
        address2: a.address2 ?? null,
        city: a.city ?? null,
        province: a.province ?? null,
        zip: a.zip ?? null,
        countryCode: a.country_code?.length === 2 ? a.country_code.toUpperCase() : null,
        phone: a.phone ?? null,
      }
    : null;

const minorString = (v: string | number | null | undefined, fallbackZero = false) => {
  const m = decimalToMinor(v);
  if (m === null) {
    if (fallbackZero && (v === null || v === undefined)) return "0";
    throw new Error("unparseable amount");
  }
  return m.toString();
};

/** Shopify order JSON → ExternalOrder, or null when the payload is not a usable order. */
export function normalizeShopifyOrder(payload: unknown): ExternalOrder | null {
  const parsed = shopifyOrder.safeParse(payload);
  if (!parsed.success) return null;
  const o = parsed.data;
  try {
    const name = [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ");
    const candidate = {
      externalOrderId: o.id,
      externalOrderNumber: o.name ?? null,
      currency: o.currency.toUpperCase(),
      placedAt: o.processed_at ?? o.created_at ?? null,
      financialStatus: (FINANCIAL as readonly string[]).includes(o.financial_status ?? "")
        ? o.financial_status
        : "other",
      cancelled: !!o.cancelled_at,
      test: !!o.test,
      customer:
        o.customer || o.email
          ? {
              externalId: o.customer?.id ?? null,
              email: o.customer?.email ?? o.email ?? null,
              name: name || null,
              phone: o.customer?.phone ?? null,
            }
          : null,
      shipTo: addr(o.shipping_address),
      billTo: addr(o.billing_address),
      subtotalMinor: minorString(o.subtotal_price, true),
      shippingMinor: minorString(o.total_shipping_price_set?.shop_money?.amount, true),
      totalMinor: minorString(o.total_price, true),
      lines: o.line_items
        .map((l) => ({ l, qty: l.current_quantity ?? l.quantity }))
        .filter(({ qty }) => qty > 0)
        .map(({ l, qty }) => ({
          externalLineItemId: l.id,
          externalVariantId: l.variant_id ?? null,
          sku: l.sku || null,
          title: l.title ?? l.name ?? null,
          quantity: qty,
          unitPriceMinor: minorString(l.price),
        })),
    };
    const out = externalOrderSchema.safeParse(candidate);
    return out.success ? out.data : null;
  } catch {
    return null;
  }
}
