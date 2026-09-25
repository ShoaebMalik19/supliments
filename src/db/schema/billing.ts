import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { currency, currencyCheck, minor, pk, timestamps, ts } from "./_columns";
import {
  chargeKind,
  chargeStatus,
  invoiceStatus,
  ledgerAccount,
  paymentMethodStatus,
  refundStatus,
  subscriptionStatus,
} from "./enums";
import { orgId, users } from "./tenancy";
import { feeSchedules, plans } from "./catalog";
import { assets } from "./branding";
import { claims, orders } from "./orders";

export const subscriptions = pgTable("subscriptions", {
  id: pk(),
  orgId: orgId().unique(),
  planId: uuid("plan_id")
    .notNull()
    .references(() => plans.id),
  provider: text("provider").notNull().default("manual"),
  providerSubscriptionId: text("provider_subscription_id"),
  status: subscriptionStatus("status").notNull(),
  currentPeriodStart: ts("current_period_start"),
  currentPeriodEnd: ts("current_period_end"),
  cancelAt: ts("cancel_at"),
  trialEnd: ts("trial_end"),
  ...timestamps,
});

export const charges = pgTable(
  "charges",
  {
    id: pk(),
    orgId: orgId(),
    orderId: uuid("order_id").references(() => orders.id),
    kind: chargeKind("kind").notNull(),
    amountMinor: minor("amount_minor").notNull(),
    currency: currency().notNull(),
    provider: text("provider").notNull().default("manual"),
    providerPaymentIntentId: text("provider_payment_intent_id"),
    status: chargeStatus("status").notNull().default("pending_external"),
    feeScheduleId: uuid("fee_schedule_id").references(() => feeSchedules.id),
    failureCode: text("failure_code"),
    attempts: integer("attempts").notNull().default(0),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    markedPaidBy: uuid("marked_paid_by").references(() => users.id),
    markedPaidAt: ts("marked_paid_at"),
    ...timestamps,
  },
  (t) => [
    currencyCheck("charges"),
    check("charges_amount_nonneg", sql`${t.amountMinor} >= 0`),
    index().on(t.orgId, t.orderId),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: pk(),
    orgId: orgId(),
    orderId: uuid("order_id").references(() => orders.id),
    chargeId: uuid("charge_id").references(() => charges.id),
    feeScheduleId: uuid("fee_schedule_id").references(() => feeSchedules.id),
    account: ledgerAccount("account").notNull(),
    amountMinor: minor("amount_minor").notNull(),
    currency: currency().notNull(),
    memo: text("memo"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [currencyCheck("ledger_entries"), index().on(t.orgId, t.orderId)],
);

export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: pk(),
    orgId: orgId(),
    provider: text("provider").notNull(),
    providerPmId: text("provider_pm_id").notNull(),
    brand: text("brand"),
    last4: char("last4", { length: 4 }),
    expMonth: integer("exp_month"),
    expYear: integer("exp_year"),
    isDefault: boolean("is_default").notNull().default(false),
    status: paymentMethodStatus("status").notNull().default("active"),
    ...timestamps,
  },
  (t) => [unique().on(t.provider, t.providerPmId), index().on(t.orgId)],
);

export const walletTransactions = pgTable(
  "wallet_transactions",
  {
    id: pk(),
    orgId: orgId(),
    deltaMinor: minor("delta_minor").notNull(),
    balanceAfterMinor: minor("balance_after_minor").notNull(),
    currency: currency().notNull(),
    reason: text("reason").notNull(),
    refType: text("ref_type"),
    refId: uuid("ref_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [currencyCheck("wallet_transactions"), index().on(t.orgId, t.createdAt)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: pk(),
    orgId: orgId(),
    number: text("number").notNull().unique(),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    subtotalMinor: minor("subtotal_minor").notNull(),
    taxMinor: minor("tax_minor")
      .notNull()
      .default(sql`0`),
    totalMinor: minor("total_minor").notNull(),
    currency: currency().notNull(),
    status: invoiceStatus("status").notNull().default("draft"),
    pdfAssetId: uuid("pdf_asset_id").references(() => assets.id),
    providerInvoiceId: text("provider_invoice_id"),
    ...timestamps,
  },
  (t) => [currencyCheck("invoices"), index().on(t.orgId)],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: pk(),
    orgId: orgId(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitAmountMinor: minor("unit_amount_minor").notNull(),
    amountMinor: minor("amount_minor").notNull(),
    currency: currency().notNull(),
    refType: text("ref_type"),
    refId: uuid("ref_id"),
    ...timestamps,
  },
  (t) => [currencyCheck("invoice_lines"), index().on(t.orgId, t.invoiceId)],
);

export const creditNotes = pgTable(
  "credit_notes",
  {
    id: pk(),
    orgId: orgId(),
    amountMinor: minor("amount_minor").notNull(),
    currency: currency().notNull(),
    reason: text("reason").notNull(),
    orderId: uuid("order_id").references(() => orders.id),
    claimId: uuid("claim_id").references(() => claims.id),
    ...timestamps,
  },
  (t) => [
    currencyCheck("credit_notes"),
    check("credit_notes_amount_positive", sql`${t.amountMinor} > 0`),
    index().on(t.orgId),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: pk(),
    orgId: orgId(),
    chargeId: uuid("charge_id")
      .notNull()
      .references(() => charges.id),
    amountMinor: minor("amount_minor").notNull(),
    currency: currency().notNull(),
    reason: text("reason"),
    providerRefundId: text("provider_refund_id"),
    status: refundStatus("status").notNull().default("pending"),
    ...timestamps,
  },
  (t) => [
    currencyCheck("refunds"),
    check("refunds_amount_positive", sql`${t.amountMinor} > 0`),
    index().on(t.orgId),
  ],
);
