import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { currency, currencyCheck, minor, pk, timestamps, ts } from "./_columns";
import { catalogStatus, inventorySource, productMode } from "./enums";

export const plans = pgTable(
  "plans",
  {
    id: pk(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    priceMinor: minor("price_minor").notNull(),
    currency: currency().notNull(),
    interval: text("interval").notNull(),
    limits: jsonb("limits").notNull().default({}),
    features: jsonb("features").notNull().default({}),
    ...timestamps,
  },
  () => [currencyCheck("plans")],
);

export const feeSchedules = pgTable(
  "fee_schedules",
  {
    id: pk(),
    version: integer("version").notNull().unique(),
    currency: currency().notNull(),
    rules: jsonb("rules").notNull(),
    effectiveFrom: ts("effective_from").notNull(),
    effectiveTo: ts("effective_to"),
    ...timestamps,
  },
  () => [currencyCheck("fee_schedules")],
);

export const suppliers = pgTable("suppliers", {
  id: pk(),
  name: text("name").notNull(),
  contact: jsonb("contact").notNull().default({}),
  country: char("country", { length: 2 }),
  terms: text("terms"),
  paymentTerms: text("payment_terms"),
  status: text("status").notNull().default("active"),
  ...timestamps,
});

export const manufacturers = pgTable("manufacturers", {
  id: pk(),
  supplierId: uuid("supplier_id").references(() => suppliers.id),
  name: text("name").notNull(),
  capabilities: jsonb("capabilities").notNull().default([]),
  leadTimeDays: integer("lead_time_days"),
  certifications: jsonb("certifications").notNull().default([]),
  adapterKey: text("adapter_key").notNull().default("manual"),
  ...timestamps,
});

export const fulfillmentCenters = pgTable("fulfillment_centers", {
  id: pk(),
  manufacturerId: uuid("manufacturer_id").references(() => manufacturers.id),
  supplierId: uuid("supplier_id").references(() => suppliers.id),
  name: text("name").notNull(),
  address: jsonb("address").notNull(),
  country: char("country", { length: 2 }).notNull(),
  regionsServed: text("regions_served").array().notNull().default([]),
  carrierAccounts: jsonb("carrier_accounts").notNull().default([]),
  cutoffTimes: jsonb("cutoff_times").notNull().default({}),
  adapterKey: text("adapter_key").notNull().default("manual"),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
});

export const categories = pgTable("categories", {
  id: pk(),
  parentId: uuid("parent_id").references((): AnyPgColumn => categories.id),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ...timestamps,
});

export const catalogProducts = pgTable(
  "catalog_products",
  {
    id: pk(),
    name: text("name").notNull(),
    categoryId: uuid("category_id").references(() => categories.id),
    description: text("description"),
    ingredients: jsonb("ingredients").notNull().default([]),
    spec: jsonb("spec").notNull().default({}),
    mode: productMode("mode").notNull().default("on_demand"),
    labelTemplateId: uuid("label_template_id").references((): AnyPgColumn => labelTemplates.id),
    defaultMsrpMinor: minor("default_msrp_minor"),
    currency: currency().notNull(),
    complianceDocs: jsonb("compliance_docs").notNull().default([]),
    restrictedCountries: text("restricted_countries").array().notNull().default([]),
    status: catalogStatus("status").notNull().default("draft"),
    ...timestamps,
  },
  () => [currencyCheck("catalog_products")],
);

export const skus = pgTable(
  "skus",
  {
    id: pk(),
    catalogProductId: uuid("catalog_product_id")
      .notNull()
      .references(() => catalogProducts.id),
    sku: text("sku").notNull().unique(),
    attributes: jsonb("attributes").notNull().default({}),
    weightGrams: integer("weight_grams"),
    dimensionsMm: jsonb("dimensions_mm"),
    barcode: text("barcode"),
    hsCode: text("hs_code"),
    baseCostMinor: minor("base_cost_minor").notNull(),
    currency: currency().notNull(),
    moq: integer("moq").notNull().default(1),
    leadTimeDays: integer("lead_time_days"),
    defaultFulfillmentCenterId: uuid("default_fulfillment_center_id").references(
      (): AnyPgColumn => fulfillmentCenters.id,
    ),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    currencyCheck("skus"),
    check("skus_base_cost_nonneg", sql`${t.baseCostMinor} >= 0`),
    index().on(t.catalogProductId),
  ],
);

export const skuCosts = pgTable(
  "sku_costs",
  {
    id: pk(),
    skuId: uuid("sku_id")
      .notNull()
      .references(() => skus.id),
    fulfillmentCenterId: uuid("fulfillment_center_id")
      .notNull()
      .references(() => fulfillmentCenters.id),
    costMinor: minor("cost_minor").notNull(),
    currency: currency().notNull(),
    effectiveFrom: ts("effective_from").notNull(),
    effectiveTo: ts("effective_to"),
    ...timestamps,
  },
  (t) => [currencyCheck("sku_costs"), index().on(t.skuId, t.fulfillmentCenterId, t.effectiveFrom)],
);

export const partnerSkuMappings = pgTable(
  "partner_sku_mappings",
  {
    id: pk(),
    skuId: uuid("sku_id")
      .notNull()
      .references(() => skus.id),
    manufacturerId: uuid("manufacturer_id")
      .notNull()
      .references(() => manufacturers.id),
    partnerSkuCode: text("partner_sku_code").notNull(),
    ...timestamps,
  },
  (t) => [unique().on(t.manufacturerId, t.skuId), unique().on(t.manufacturerId, t.partnerSkuCode)],
);

export const labelTemplates = pgTable("label_templates", {
  id: pk(),
  catalogProductId: uuid("catalog_product_id").references((): AnyPgColumn => catalogProducts.id),
  skuId: uuid("sku_id").references(() => skus.id),
  name: text("name").notNull(),
  printSpec: jsonb("print_spec").notNull(),
  editableFields: jsonb("editable_fields").notNull().default([]),
  fixedPanels: jsonb("fixed_panels").notNull().default([]),
  mockupSpec: jsonb("mockup_spec").notNull().default([]),
  isPlaceholder: boolean("is_placeholder").notNull().default(false),
  dieLineAssetId: uuid("die_line_asset_id"),
  ...timestamps,
});

export const inventory = pgTable(
  "inventory",
  {
    id: pk(),
    skuId: uuid("sku_id")
      .notNull()
      .references(() => skus.id),
    fulfillmentCenterId: uuid("fulfillment_center_id")
      .notNull()
      .references(() => fulfillmentCenters.id),
    onHand: integer("on_hand").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    available: integer("available").notNull().default(0),
    safetyStock: integer("safety_stock").notNull().default(0),
    source: inventorySource("source").notNull().default("manual"),
    ...timestamps,
  },
  (t) => [unique().on(t.skuId, t.fulfillmentCenterId)],
);

export const inventoryLedger = pgTable(
  "inventory_ledger",
  {
    id: pk(),
    skuId: uuid("sku_id")
      .notNull()
      .references(() => skus.id),
    fulfillmentCenterId: uuid("fulfillment_center_id")
      .notNull()
      .references(() => fulfillmentCenters.id),
    delta: integer("delta").notNull(),
    reason: text("reason").notNull(),
    refType: text("ref_type"),
    refId: uuid("ref_id"),
    lotNumber: text("lot_number"),
    expiresOn: date("expires_on"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index().on(t.skuId, t.fulfillmentCenterId)],
);
