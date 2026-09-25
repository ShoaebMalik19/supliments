import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
  assetKind,
  assetUploadStatus,
  brandProductStatus,
  brandStatus,
  labelStatus,
  virusScanStatus,
} from "./enums";
import { orgId, organizations, users } from "./tenancy";
import { catalogProducts, fulfillmentCenters, labelTemplates, skus } from "./catalog";

export const assets = pgTable(
  "assets",
  {
    id: pk(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    kind: assetKind("kind").notNull(),
    bucket: text("bucket").notNull(),
    storageKey: text("storage_key").notNull(),
    mime: text("mime").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    width: integer("width"),
    height: integer("height"),
    checksum: text("checksum"),
    uploadStatus: assetUploadStatus("upload_status").notNull().default("pending"),
    virusScanStatus: virusScanStatus("virus_scan_status").notNull().default("pending"),
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    isPublic: boolean("is_public").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique().on(t.bucket, t.storageKey),
    index().on(t.orgId),
    check(
      "assets_storage_key_scoped",
      sql`(${t.orgId} IS NULL AND ${t.storageKey} LIKE 'platform/%') OR ${t.storageKey} LIKE 'org/' || ${t.orgId}::text || '/%'`,
    ),
  ],
);

export const brands = pgTable(
  "brands",
  {
    id: pk(),
    orgId: orgId(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logoAssetId: uuid("logo_asset_id").references(() => assets.id),
    colors: jsonb("colors").notNull().default({}),
    story: text("story"),
    supportEmail: text("support_email"),
    returnAddress: jsonb("return_address"),
    status: brandStatus("status").notNull().default("active"),
    ...timestamps,
  },
  (t) => [unique().on(t.orgId, t.slug)],
);

export const brandProducts = pgTable(
  "brand_products",
  {
    id: pk(),
    orgId: orgId(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id),
    catalogProductId: uuid("catalog_product_id")
      .notNull()
      .references(() => catalogProducts.id),
    title: text("title").notNull(),
    description: text("description"),
    retailPriceMinor: minor("retail_price_minor").notNull(),
    currency: currency().notNull(),
    status: brandProductStatus("status").notNull().default("draft"),
    primaryMockupAssetId: uuid("primary_mockup_asset_id").references(() => assets.id),
    ...timestamps,
  },
  (t) => [
    currencyCheck("brand_products"),
    check("brand_products_price_nonneg", sql`${t.retailPriceMinor} >= 0`),
    index().on(t.orgId, t.brandId),
  ],
);

export const brandProductVariants = pgTable(
  "brand_product_variants",
  {
    id: pk(),
    orgId: orgId(),
    brandProductId: uuid("brand_product_id")
      .notNull()
      .references(() => brandProducts.id, { onDelete: "cascade" }),
    skuId: uuid("sku_id")
      .notNull()
      .references(() => skus.id),
    retailPriceMinor: minor("retail_price_minor").notNull(),
    currency: currency().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    currencyCheck("brand_product_variants"),
    check("brand_product_variants_price_nonneg", sql`${t.retailPriceMinor} >= 0`),
    unique().on(t.brandProductId, t.skuId),
    index().on(t.orgId),
  ],
);

export const labels = pgTable(
  "labels",
  {
    id: pk(),
    orgId: orgId(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id),
    brandProductId: uuid("brand_product_id")
      .notNull()
      .references(() => brandProducts.id),
    labelTemplateId: uuid("label_template_id")
      .notNull()
      .references(() => labelTemplates.id),
    version: integer("version").notNull(),
    designState: jsonb("design_state").notNull().default({}),
    previewAssetId: uuid("preview_asset_id").references(() => assets.id),
    printFileAssetId: uuid("print_file_asset_id").references(() => assets.id),
    mockupAssetIds: uuid("mockup_asset_ids").array().notNull().default([]),
    status: labelStatus("status").notNull().default("draft"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    rejectionReason: text("rejection_reason"),
    ...timestamps,
  },
  (t) => [
    unique().on(t.brandProductId, t.version),
    check("labels_version_positive", sql`${t.version} > 0`),
    index().on(t.orgId),
  ],
);

export const brandInventory = pgTable(
  "brand_inventory",
  {
    id: pk(),
    orgId: orgId(),
    skuId: uuid("sku_id")
      .notNull()
      .references(() => skus.id),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id),
    fulfillmentCenterId: uuid("fulfillment_center_id").references(() => fulfillmentCenters.id),
    quantity: integer("quantity").notNull().default(0),
    lotNumber: text("lot_number"),
    ...timestamps,
  },
  (t) => [
    check("brand_inventory_qty_nonneg", sql`${t.quantity} >= 0`),
    index().on(t.orgId, t.skuId),
  ],
);
