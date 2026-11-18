import { z } from "zod";
import type { PrivacyRequest } from "@/modules/integrations/provider";

const id = z.union([z.number().int(), z.string().regex(/^\d{1,20}$/)]).transform(String);
const customer = z
  .object({
    id: id.nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .transform((c) => ({ externalId: c.id ?? null, email: c.email ?? null, phone: c.phone ?? null }));

const dataRequest = z.object({
  shop_domain: z.string(),
  customer,
  orders_requested: z.array(id).nullish(),
  data_request: z.object({ id: id.nullish() }).nullish(),
});
const customerRedact = z.object({
  shop_domain: z.string(),
  customer,
  orders_to_redact: z.array(id).nullish(),
});
const shopRedact = z.object({ shop_domain: z.string() });

/** Shopify's mandatory compliance webhooks → PrivacyRequest. */
export function normalizeShopifyPrivacyRequest(
  topic: string,
  payload: unknown,
): PrivacyRequest | null {
  if (topic === "customers/data_request") {
    const r = dataRequest.safeParse(payload);
    if (!r.success) return null;
    return {
      type: "customer_data_request",
      shop: r.data.shop_domain.toLowerCase(),
      requestId: r.data.data_request?.id ?? null,
      customer: r.data.customer,
      externalOrderIds: r.data.orders_requested ?? [],
    };
  }
  if (topic === "customers/redact") {
    const r = customerRedact.safeParse(payload);
    if (!r.success) return null;
    return {
      type: "customer_redact",
      shop: r.data.shop_domain.toLowerCase(),
      customer: r.data.customer,
      externalOrderIds: r.data.orders_to_redact ?? [],
    };
  }
  if (topic === "shop/redact") {
    const r = shopRedact.safeParse(payload);
    return r.success ? { type: "shop_redact", shop: r.data.shop_domain.toLowerCase() } : null;
  }
  return null;
}
