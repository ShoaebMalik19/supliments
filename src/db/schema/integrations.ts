import { boolean, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { currency, currencyCheck, pk, timestamps, ts } from "./_columns";
import {
  integrationProvider,
  integrationStatus,
  jobStatus,
  syncStatus,
  webhookStatus,
} from "./enums";
import { orgId, organizations, users } from "./tenancy";
import { brandProductVariants, brands } from "./branding";

export const integrations = pgTable(
  "integrations",
  {
    id: pk(),
    orgId: orgId(),
    brandId: uuid("brand_id").references(() => brands.id),
    provider: integrationProvider("provider").notNull(),
    externalShopId: text("external_shop_id").notNull(),
    domain: text("domain"),
    status: integrationStatus("status").notNull().default("connected"),
    scopes: text("scopes").array().notNull().default([]),
    credentialsCiphertext: text("credentials_ciphertext"),
    credentialsKeyId: text("credentials_key_id"),
    installedAt: ts("installed_at"),
    lastSyncAt: ts("last_sync_at"),
    ordersSyncedThrough: ts("orders_synced_through"),
    ...timestamps,
  },
  (t) => [unique().on(t.provider, t.externalShopId), index().on(t.orgId)],
);

export const oauthStates = pgTable(
  "oauth_states",
  {
    id: pk(),
    orgId: orgId(),
    provider: integrationProvider("provider").notNull(),
    shop: text("shop").notNull(),
    stateHash: text("state_hash").notNull().unique(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId)],
);

export const stores = pgTable(
  "stores",
  {
    id: pk(),
    orgId: orgId(),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id),
    domain: text("domain"),
    currency: currency().notNull(),
    defaultLocationId: text("default_location_id"),
    ...timestamps,
  },
  (t) => [currencyCheck("stores"), index().on(t.orgId)],
);

export const productSyncMappings = pgTable(
  "product_sync_mappings",
  {
    id: pk(),
    orgId: orgId(),
    brandProductVariantId: uuid("brand_product_variant_id")
      .notNull()
      .references(() => brandProductVariants.id),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id),
    externalProductId: text("external_product_id"),
    externalVariantId: text("external_variant_id").notNull(),
    externalInventoryItemId: text("external_inventory_item_id"),
    lastPushedAt: ts("last_pushed_at"),
    lastPushHash: text("last_push_hash"),
    syncStatus: syncStatus("sync_status").notNull().default("pending"),
    error: text("error"),
    ...timestamps,
  },
  (t) => [unique().on(t.integrationId, t.externalVariantId), index().on(t.orgId)],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: pk(),
    provider: integrationProvider("provider").notNull(),
    integrationId: uuid("integration_id").references(() => integrations.id),
    topic: text("topic").notNull(),
    externalEventId: text("external_event_id"),
    payload: jsonb("payload").notNull(),
    signatureValid: boolean("signature_valid").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    status: webhookStatus("status").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    dedupeKey: text("dedupe_key").notNull().unique(),
  },
  (t) => [index().on(t.status, t.receivedAt)],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: pk(),
    orgId: uuid("org_id").references(() => organizations.id),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    publishedAt: ts("published_at"),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [index().on(t.publishedAt, t.createdAt)],
);

export const jobQueue = pgTable(
  "job_queue",
  {
    id: pk(),
    orgId: uuid("org_id").references(() => organizations.id),
    queue: text("queue").notNull().default("default"),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: jobStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    runAt: ts("run_at").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key").unique(),
    completedAt: ts("completed_at"),
    ...timestamps,
  },
  (t) => [index().on(t.status, t.runAt)],
);
