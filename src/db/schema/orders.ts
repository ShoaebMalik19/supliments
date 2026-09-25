import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { currency, currencyCheck, minor, pk, timestamps, ts } from "./_columns";
import {
  actorType,
  claimResolution,
  claimStatus,
  claimType,
  dispatchBatchStatus,
  fulfillmentStatus,
  orderItemStatus,
  orderStatus,
  returnStatus,
  shipmentStatus,
} from "./enums";
import { orgId, users } from "./tenancy";
import { assets, brandProductVariants, brands, labels } from "./branding";
import { fulfillmentCenters, skus } from "./catalog";
import { integrations } from "./integrations";

export const customers = pgTable(
  "customers",
  {
    id: pk(),
    orgId: orgId(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id),
    externalCustomerId: text("external_customer_id"),
    email: text("email"),
    phone: text("phone"),
    name: text("name"),
    ...timestamps,
  },
  (t) => [index().on(t.orgId, t.brandId)],
);

export const orders = pgTable(
  "orders",
  {
    id: pk(),
    orgId: orgId(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id),
    integrationId: uuid("integration_id").references(() => integrations.id),
    externalOrderId: text("external_order_id"),
    externalOrderNumber: text("external_order_number"),
    customerId: uuid("customer_id").references(() => customers.id),
    shipTo: jsonb("ship_to").notNull(),
    billTo: jsonb("bill_to"),
    currency: currency().notNull(),
    retailSubtotalMinor: minor("retail_subtotal_minor")
      .notNull()
      .default(sql`0`),
    retailShippingMinor: minor("retail_shipping_minor")
      .notNull()
      .default(sql`0`),
    retailTotalMinor: minor("retail_total_minor")
      .notNull()
      .default(sql`0`),
    status: orderStatus("status").notNull().default("received"),
    placedAt: ts("placed_at"),
    importedAt: ts("imported_at").notNull().defaultNow(),
    holdReason: text("hold_reason"),
    riskFlags: jsonb("risk_flags").notNull().default([]),
    ...timestamps,
  },
  (t) => [
    currencyCheck("orders"),
    unique().on(t.integrationId, t.externalOrderId),
    index().on(t.orgId, t.status),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: pk(),
    orgId: orgId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    brandProductVariantId: uuid("brand_product_variant_id").references(
      () => brandProductVariants.id,
    ),
    skuId: uuid("sku_id").references(() => skus.id),
    labelId: uuid("label_id").references(() => labels.id),
    quantity: integer("quantity").notNull(),
    currency: currency().notNull(),
    retailUnitPriceMinor: minor("retail_unit_price_minor"),
    costUnitMinor: minor("cost_unit_minor"),
    fulfillmentFeeMinor: minor("fulfillment_fee_minor"),
    status: orderItemStatus("status").notNull().default("pending"),
    externalLineItemId: text("external_line_item_id"),
    lotNumber: text("lot_number"),
    batchCode: text("batch_code"),
    expiresOn: date("expires_on"),
    ...timestamps,
  },
  (t) => [
    currencyCheck("order_items"),
    check("order_items_qty_positive", sql`${t.quantity} > 0`),
    index().on(t.orgId, t.orderId),
  ],
);

export const orderEvents = pgTable(
  "order_events",
  {
    id: pk(),
    orgId: orgId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    type: text("type").notNull(),
    fromStatus: orderStatus("from_status"),
    toStatus: orderStatus("to_status"),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.orderId, t.createdAt)],
);

export const dispatchBatches = pgTable("dispatch_batches", {
  id: pk(),
  fulfillmentCenterId: uuid("fulfillment_center_id")
    .notNull()
    .references(() => fulfillmentCenters.id),
  adapterKey: text("adapter_key").notNull(),
  status: dispatchBatchStatus("status").notNull().default("draft"),
  fileAssetId: uuid("file_asset_id").references(() => assets.id),
  rowCount: integer("row_count").notNull().default(0),
  exportedAt: ts("exported_at"),
  exportedBy: uuid("exported_by").references(() => users.id),
  importedAt: ts("imported_at"),
  ...timestamps,
});

export const fulfillmentOrders = pgTable(
  "fulfillment_orders",
  {
    id: pk(),
    orgId: orgId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    fulfillmentCenterId: uuid("fulfillment_center_id")
      .notNull()
      .references(() => fulfillmentCenters.id),
    adapterKey: text("adapter_key").notNull(),
    dispatchBatchId: uuid("dispatch_batch_id").references(() => dispatchBatches.id),
    dispatchRow: integer("dispatch_row"),
    externalFulfillmentId: text("external_fulfillment_id"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: fulfillmentStatus("status").notNull().default("pending"),
    submittedAt: ts("submitted_at"),
    acceptedAt: ts("accepted_at"),
    requestSnapshot: jsonb("request_snapshot"),
    responseSnapshot: jsonb("response_snapshot"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [index().on(t.orgId, t.orderId), unique().on(t.dispatchBatchId, t.dispatchRow)],
);

export const shipments = pgTable(
  "shipments",
  {
    id: pk(),
    orgId: orgId(),
    fulfillmentOrderId: uuid("fulfillment_order_id")
      .notNull()
      .references(() => fulfillmentOrders.id),
    carrier: text("carrier").notNull(),
    service: text("service"),
    trackingNumber: text("tracking_number"),
    trackingUrl: text("tracking_url"),
    shippedAt: ts("shipped_at"),
    deliveredAt: ts("delivered_at"),
    weightGrams: integer("weight_grams"),
    costMinor: minor("cost_minor"),
    currency: currency().notNull(),
    labelAssetId: uuid("label_asset_id").references(() => assets.id),
    pushedToStoreAt: ts("pushed_to_store_at"),
    status: shipmentStatus("status").notNull().default("label_created"),
    lotNumber: text("lot_number"),
    batchCode: text("batch_code"),
    ...timestamps,
  },
  (t) => [
    currencyCheck("shipments"),
    unique().on(t.carrier, t.trackingNumber),
    index().on(t.orgId, t.fulfillmentOrderId),
  ],
);

export const shipmentItems = pgTable(
  "shipment_items",
  {
    id: pk(),
    orgId: orgId(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id),
    quantity: integer("quantity").notNull(),
    lotNumber: text("lot_number"),
    batchCode: text("batch_code"),
    expiresOn: date("expires_on"),
    ...timestamps,
  },
  (t) => [check("shipment_items_qty_positive", sql`${t.quantity} > 0`), index().on(t.orgId)],
);

export const trackingEvents = pgTable(
  "tracking_events",
  {
    id: pk(),
    orgId: orgId(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    occurredAt: ts("occurred_at").notNull(),
    statusCode: text("status_code").notNull(),
    description: text("description"),
    location: text("location"),
    raw: jsonb("raw"),
    source: text("source").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.shipmentId, t.occurredAt, t.statusCode), index().on(t.orgId)],
);

export const returns = pgTable(
  "returns",
  {
    id: pk(),
    orgId: orgId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    rmaNumber: text("rma_number").notNull().unique(),
    reason: text("reason"),
    status: returnStatus("status").notNull().default("requested"),
    returnShipmentId: uuid("return_shipment_id").references(() => shipments.id),
    resolution: text("resolution"),
    costBearer: text("cost_bearer"),
    ...timestamps,
  },
  (t) => [index().on(t.orgId)],
);

export const claims = pgTable(
  "claims",
  {
    id: pk(),
    orgId: orgId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    shipmentId: uuid("shipment_id").references(() => shipments.id),
    type: claimType("type").notNull(),
    evidenceAssetIds: uuid("evidence_asset_ids").array().notNull().default([]),
    status: claimStatus("status").notNull().default("open"),
    resolution: claimResolution("resolution"),
    amountMinor: minor("amount_minor"),
    currency: currency().notNull(),
    ...timestamps,
  },
  (t) => [currencyCheck("claims"), index().on(t.orgId)],
);
