import { pgEnum } from "drizzle-orm/pg-core";

export const orgStatus = pgEnum("org_status", ["active", "past_due", "suspended"]);
export const memberRole = pgEnum("member_role", [
  "owner",
  "admin",
  "member",
  "designer",
  "read_only",
]);
export const actorType = pgEnum("actor_type", ["user", "admin", "system", "integration"]);

export const productMode = pgEnum("product_mode", ["on_demand", "stocked"]);
export const catalogStatus = pgEnum("catalog_status", ["draft", "active", "discontinued"]);
export const inventorySource = pgEnum("inventory_source", ["partner_feed", "manual"]);

export const assetKind = pgEnum("asset_kind", [
  "logo",
  "label_print",
  "label_preview",
  "mockup",
  "product_image",
  "document",
]);
export const assetUploadStatus = pgEnum("asset_upload_status", ["pending", "ready", "rejected"]);
export const virusScanStatus = pgEnum("virus_scan_status", [
  "pending",
  "clean",
  "infected",
  "error",
]);
export const brandStatus = pgEnum("brand_status", ["active", "archived"]);
export const brandProductStatus = pgEnum("brand_product_status", [
  "draft",
  "pending_review",
  "approved",
  "published",
  "unpublished",
  "archived",
]);
export const labelStatus = pgEnum("label_status", [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "superseded",
]);

export const integrationProvider = pgEnum("integration_provider", [
  "shopify",
  "woocommerce",
  "manual",
  "api",
]);
export const integrationStatus = pgEnum("integration_status", [
  "connected",
  "needs_reauth",
  "disconnected",
]);
export const syncStatus = pgEnum("sync_status", ["pending", "synced", "failed"]);
export const webhookStatus = pgEnum("webhook_status", [
  "received",
  "processed",
  "failed",
  "ignored",
]);
export const jobStatus = pgEnum("job_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "dead",
]);

export const orderStatus = pgEnum("order_status", [
  "received",
  "needs_review",
  "on_hold",
  "awaiting_payment",
  "submitted",
  "accepted",
  "in_production",
  "packed",
  "shipped",
  "in_transit",
  "delivered",
  "returned",
  "cancelled",
  "refunded",
  "failed",
]);
export const orderItemStatus = pgEnum("order_item_status", [
  "pending",
  "needs_review",
  "submitted",
  "shipped",
  "delivered",
  "cancelled",
  "returned",
]);
export const fulfillmentStatus = pgEnum("fulfillment_status", [
  "pending",
  "exported",
  "submitted",
  "accepted",
  "in_production",
  "packed",
  "shipped",
  "cancelled",
  "failed",
]);
export const dispatchBatchStatus = pgEnum("dispatch_batch_status", [
  "draft",
  "exported",
  "partially_imported",
  "completed",
  "cancelled",
]);
export const shipmentStatus = pgEnum("shipment_status", [
  "label_created",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "exception",
  "returned",
]);
export const returnStatus = pgEnum("return_status", [
  "requested",
  "approved",
  "in_transit",
  "received",
  "inspected",
  "restocked",
  "destroyed",
  "rejected",
]);
export const claimType = pgEnum("claim_type", ["damaged", "lost", "wrong_item", "defect", "late"]);
export const claimStatus = pgEnum("claim_status", [
  "open",
  "investigating",
  "resolved",
  "rejected",
]);
export const claimResolution = pgEnum("claim_resolution", ["credit", "reship", "denied"]);

export const chargeKind = pgEnum("charge_kind", [
  "order",
  "subscription",
  "wallet_topup",
  "service_fee",
]);
export const chargeStatus = pgEnum("charge_status", [
  "pending_external",
  "requires_action",
  "pending",
  "succeeded",
  "failed",
  "refunded",
  "disputed",
]);
export const ledgerAccount = pgEnum("ledger_account", [
  "cogs",
  "fulfillment_fee",
  "shipping",
  "platform_markup",
  "payment",
  "refund",
  "credit",
  "adjustment",
]);
export const subscriptionStatus = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "cancelled",
]);
export const invoiceStatus = pgEnum("invoice_status", [
  "draft",
  "open",
  "paid",
  "void",
  "uncollectible",
]);
export const refundStatus = pgEnum("refund_status", ["pending", "succeeded", "failed"]);
export const paymentMethodStatus = pgEnum("payment_method_status", [
  "active",
  "expired",
  "removed",
]);

export const notificationChannel = pgEnum("notification_channel", ["email", "sms", "in_app"]);
export const notificationStatus = pgEnum("notification_status", [
  "pending",
  "sent",
  "failed",
  "read",
]);
export const reviewItemType = pgEnum("review_item_type", [
  "label_review",
  "failed_fulfillment",
  "address_hold",
  "payment_hold",
  "claim",
  "integration_conflict",
]);
export const reviewItemStatus = pgEnum("review_item_status", [
  "open",
  "in_progress",
  "done",
  "dismissed",
]);
