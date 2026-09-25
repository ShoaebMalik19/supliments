import { z } from "zod";
import { currencyInput, minorUnitsInput } from "@/lib/money";

const address = z
  .object({
    name: z.string().nullish(),
    company: z.string().nullish(),
    address1: z.string().nullish(),
    address2: z.string().nullish(),
    city: z.string().nullish(),
    province: z.string().nullish(),
    zip: z.string().nullish(),
    countryCode: z.string().length(2).nullish(),
    phone: z.string().nullish(),
  })
  .nullable();

/**
 * Canonical order as any commerce adapter delivers it. Adapters normalize into this;
 * the orders module never sees a provider payload.
 */
export const externalOrderSchema = z.strictObject({
  externalOrderId: z.string().min(1),
  externalOrderNumber: z.string().nullable(),
  currency: currencyInput,
  placedAt: z.coerce.date().nullable(),
  financialStatus: z.enum(["pending", "paid", "partially_paid", "refunded", "voided", "other"]),
  cancelled: z.boolean(),
  test: z.boolean(),
  customer: z
    .object({
      externalId: z.string().nullable(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      phone: z.string().nullable(),
    })
    .nullable(),
  shipTo: address,
  billTo: address,
  subtotalMinor: minorUnitsInput,
  shippingMinor: minorUnitsInput,
  totalMinor: minorUnitsInput,
  lines: z.array(
    z.strictObject({
      externalLineItemId: z.string().min(1),
      externalVariantId: z.string().nullable(),
      sku: z.string().nullable(),
      title: z.string().nullable(),
      quantity: z.int().positive(),
      unitPriceMinor: minorUnitsInput,
    }),
  ),
});

export type ExternalOrder = z.output<typeof externalOrderSchema>;

export type IngestTarget = { orgId: string; integrationId: string };

export type IngestResult =
  | { outcome: "created" | "updated" | "duplicate"; orderId: string; status: string }
  | { outcome: "ignored"; reason: string };
