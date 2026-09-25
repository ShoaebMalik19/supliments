import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { currency, currencyCheck, minor, pk, timestamps, ts } from "./_columns";
import { actorType, memberRole, orgStatus } from "./enums";
import { plans } from "./catalog";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  lastLoginAt: ts("last_login_at"),
  ...timestamps,
});

export const organizations = pgTable(
  "organizations",
  {
    id: pk(),
    name: text("name").notNull(),
    country: char("country", { length: 2 }),
    billingEmail: text("billing_email"),
    planId: uuid("plan_id").references(() => plans.id),
    status: orgStatus("status").notNull().default("active"),
    providerCustomerId: text("provider_customer_id"),
    walletBalanceMinor: minor("wallet_balance_minor")
      .notNull()
      .default(sql`0`),
    currency: currency().notNull().default("USD"),
    settings: jsonb("settings").notNull().default({}),
    ...timestamps,
  },
  () => [currencyCheck("organizations")],
);

export const orgId = () =>
  uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

export const platformAdmins = pgTable("platform_admins", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  grantedBy: uuid("granted_by").references(() => users.id),
  createdAt: timestamps.createdAt,
});

export const memberships = pgTable(
  "memberships",
  {
    id: pk(),
    orgId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id),
    acceptedAt: ts("accepted_at"),
    ...timestamps,
  },
  (t) => [unique().on(t.userId, t.orgId), index().on(t.orgId)],
);

export const invitations = pgTable("invitations", {
  id: pk(),
  orgId: orgId(),
  email: text("email").notNull(),
  role: memberRole("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: uuid("invited_by").references(() => users.id),
  expiresAt: ts("expires_at").notNull(),
  acceptedAt: ts("accepted_at"),
  ...timestamps,
});

export const apiKeys = pgTable("api_keys", {
  id: pk(),
  orgId: orgId(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull().unique(),
  hashedSecret: text("hashed_secret").notNull(),
  scopes: text("scopes").array().notNull().default([]),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  ...timestamps,
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: pk(),
    orgId: uuid("org_id").references(() => organizations.id),
    actorUserId: uuid("actor_user_id"),
    actorType: actorType("actor_type").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index().on(t.orgId, t.createdAt)],
);
