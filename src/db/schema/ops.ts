import { boolean, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { pk, timestamps, ts } from "./_columns";
import { notificationChannel, notificationStatus, reviewItemStatus, reviewItemType } from "./enums";
import { orgId, organizations, users } from "./tenancy";

export const notifications = pgTable(
  "notifications",
  {
    id: pk(),
    orgId: orgId(),
    userId: uuid("user_id").references(() => users.id),
    channel: notificationChannel("channel").notNull(),
    template: text("template").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: notificationStatus("status").notNull().default("pending"),
    sentAt: ts("sent_at"),
    readAt: ts("read_at"),
    ...timestamps,
  },
  (t) => [index().on(t.orgId, t.userId)],
);

export const reviewQueueItems = pgTable(
  "review_queue_items",
  {
    id: pk(),
    orgId: uuid("org_id").references(() => organizations.id),
    type: reviewItemType("type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id),
    status: reviewItemStatus("status").notNull().default("open"),
    priority: integer("priority").notNull().default(0),
    dueAt: ts("due_at"),
    ...timestamps,
  },
  (t) => [index().on(t.status, t.priority)],
);

export const featureFlags = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  rules: jsonb("rules").notNull().default({}),
  ...timestamps,
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  ...timestamps,
});

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: pk(),
    orgId: orgId(),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.orgId, t.scope, t.key)],
);
