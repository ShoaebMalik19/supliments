CREATE TYPE "public"."actor_type" AS ENUM('user', 'admin', 'system', 'integration');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('logo', 'label_print', 'label_preview', 'mockup', 'product_image', 'document');--> statement-breakpoint
CREATE TYPE "public"."brand_product_status" AS ENUM('draft', 'pending_review', 'approved', 'published', 'unpublished', 'archived');--> statement-breakpoint
CREATE TYPE "public"."brand_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."catalog_status" AS ENUM('draft', 'active', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."charge_kind" AS ENUM('order', 'subscription', 'wallet_topup', 'service_fee');--> statement-breakpoint
CREATE TYPE "public"."charge_status" AS ENUM('pending_external', 'requires_action', 'pending', 'succeeded', 'failed', 'refunded', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."claim_resolution" AS ENUM('credit', 'reship', 'denied');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('open', 'investigating', 'resolved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."claim_type" AS ENUM('damaged', 'lost', 'wrong_item', 'defect', 'late');--> statement-breakpoint
CREATE TYPE "public"."dispatch_batch_status" AS ENUM('draft', 'exported', 'partially_imported', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_status" AS ENUM('pending', 'exported', 'submitted', 'accepted', 'in_production', 'packed', 'shipped', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('shopify', 'woocommerce', 'manual', 'api');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('connected', 'needs_reauth', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."inventory_source" AS ENUM('partner_feed', 'manual');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'open', 'paid', 'void', 'uncollectible');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."label_status" AS ENUM('draft', 'submitted', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('cogs', 'fulfillment_fee', 'shipping', 'platform_markup', 'payment', 'refund', 'credit', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member', 'designer', 'read_only');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('email', 'sms', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed', 'read');--> statement-breakpoint
CREATE TYPE "public"."order_item_status" AS ENUM('pending', 'needs_review', 'submitted', 'shipped', 'delivered', 'cancelled', 'returned');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('received', 'needs_review', 'on_hold', 'awaiting_payment', 'submitted', 'accepted', 'in_production', 'packed', 'shipped', 'in_transit', 'delivered', 'returned', 'cancelled', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."org_status" AS ENUM('active', 'past_due', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."payment_method_status" AS ENUM('active', 'expired', 'removed');--> statement-breakpoint
CREATE TYPE "public"."product_mode" AS ENUM('on_demand', 'stocked');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."return_status" AS ENUM('requested', 'approved', 'in_transit', 'received', 'inspected', 'restocked', 'destroyed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."review_item_status" AS ENUM('open', 'in_progress', 'done', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."review_item_type" AS ENUM('label_review', 'failed_fulfillment', 'address_hold', 'payment_hold', 'claim');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('label_created', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('pending', 'synced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."virus_scan_status" AS ENUM('pending', 'clean', 'infected', 'error');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('received', 'processed', 'failed', 'ignored');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hashed_secret" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid,
	"actor_user_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"invited_by" uuid,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_org_id_unique" UNIQUE("user_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name" text NOT NULL,
	"country" char(2),
	"billing_email" text,
	"plan_id" uuid,
	"status" "org_status" DEFAULT 'active' NOT NULL,
	"provider_customer_id" text,
	"wallet_balance_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "catalog_products" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid,
	"description" text,
	"ingredients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mode" "product_mode" DEFAULT 'on_demand' NOT NULL,
	"label_template_id" uuid,
	"default_msrp_minor" bigint,
	"currency" char(3) NOT NULL,
	"compliance_docs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"restricted_countries" text[] DEFAULT '{}' NOT NULL,
	"status" "catalog_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_products_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "fee_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"version" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"rules" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_schedules_version_unique" UNIQUE("version"),
	CONSTRAINT "fee_schedules_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "fulfillment_centers" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"manufacturer_id" uuid,
	"supplier_id" uuid,
	"name" text NOT NULL,
	"address" jsonb NOT NULL,
	"country" char(2) NOT NULL,
	"regions_served" text[] DEFAULT '{}' NOT NULL,
	"carrier_accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cutoff_times" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"adapter_key" text DEFAULT 'manual' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"sku_id" uuid NOT NULL,
	"fulfillment_center_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"available" integer DEFAULT 0 NOT NULL,
	"safety_stock" integer DEFAULT 0 NOT NULL,
	"source" "inventory_source" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_sku_id_fulfillment_center_id_unique" UNIQUE("sku_id","fulfillment_center_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_ledger" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"sku_id" uuid NOT NULL,
	"fulfillment_center_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"lot_number" text,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "label_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"catalog_product_id" uuid,
	"sku_id" uuid,
	"name" text NOT NULL,
	"print_spec" jsonb NOT NULL,
	"editable_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fixed_panels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"die_line_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manufacturers" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"supplier_id" uuid,
	"name" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lead_time_days" integer,
	"certifications" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"adapter_key" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_sku_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"sku_id" uuid NOT NULL,
	"manufacturer_id" uuid NOT NULL,
	"partner_sku_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_sku_mappings_manufacturer_id_sku_id_unique" UNIQUE("manufacturer_id","sku_id"),
	CONSTRAINT "partner_sku_mappings_manufacturer_id_partner_sku_code_unique" UNIQUE("manufacturer_id","partner_sku_code")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"price_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"interval" text NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_unique" UNIQUE("code"),
	CONSTRAINT "plans_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "sku_costs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"sku_id" uuid NOT NULL,
	"fulfillment_center_id" uuid NOT NULL,
	"cost_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_costs_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"catalog_product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"weight_grams" integer,
	"dimensions_mm" jsonb,
	"barcode" text,
	"hs_code" text,
	"base_cost_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"moq" integer DEFAULT 1 NOT NULL,
	"lead_time_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skus_sku_unique" UNIQUE("sku"),
	CONSTRAINT "skus_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "skus_base_cost_nonneg" CHECK ("skus"."base_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name" text NOT NULL,
	"contact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"country" char(2),
	"terms" text,
	"payment_terms" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid,
	"kind" "asset_kind" NOT NULL,
	"bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"checksum" text,
	"virus_scan_status" "virus_scan_status" DEFAULT 'pending' NOT NULL,
	"uploaded_by" uuid,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_bucket_storage_key_unique" UNIQUE("bucket","storage_key")
);
--> statement-breakpoint
CREATE TABLE "brand_inventory" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"fulfillment_center_id" uuid,
	"quantity" integer DEFAULT 0 NOT NULL,
	"lot_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_inventory_qty_nonneg" CHECK ("brand_inventory"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "brand_product_variants" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_product_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"retail_price_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_product_variants_brand_product_id_sku_id_unique" UNIQUE("brand_product_id","sku_id"),
	CONSTRAINT "brand_product_variants_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "brand_product_variants_price_nonneg" CHECK ("brand_product_variants"."retail_price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "brand_products" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"catalog_product_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"retail_price_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "brand_product_status" DEFAULT 'draft' NOT NULL,
	"primary_mockup_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_products_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "brand_products_price_nonneg" CHECK ("brand_products"."retail_price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo_asset_id" uuid,
	"colors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"story" text,
	"support_email" text,
	"return_address" jsonb,
	"status" "brand_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_org_id_slug_unique" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"brand_product_id" uuid NOT NULL,
	"label_template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"design_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preview_asset_id" uuid,
	"print_file_asset_id" uuid,
	"status" "label_status" DEFAULT 'draft' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_brand_product_id_version_unique" UNIQUE("brand_product_id","version"),
	CONSTRAINT "labels_version_positive" CHECK ("labels"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid,
	"provider" "integration_provider" NOT NULL,
	"external_shop_id" text NOT NULL,
	"domain" text,
	"status" "integration_status" DEFAULT 'connected' NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"credentials_ciphertext" text,
	"credentials_key_id" text,
	"installed_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_provider_external_shop_id_unique" UNIQUE("provider","external_shop_id")
);
--> statement-breakpoint
CREATE TABLE "job_queue" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid,
	"queue" text DEFAULT 'default' NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"dedupe_key" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_queue_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_sync_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_product_variant_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"external_product_id" text,
	"external_variant_id" text NOT NULL,
	"external_inventory_item_id" text,
	"last_pushed_at" timestamp with time zone,
	"last_push_hash" text,
	"sync_status" "sync_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_sync_mappings_integration_id_external_variant_id_unique" UNIQUE("integration_id","external_variant_id")
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"domain" text,
	"currency" char(3) NOT NULL,
	"default_location_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"integration_id" uuid,
	"topic" text NOT NULL,
	"external_event_id" text,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" "webhook_status" DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"dedupe_key" text NOT NULL,
	CONSTRAINT "webhook_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"shipment_id" uuid,
	"type" "claim_type" NOT NULL,
	"evidence_asset_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" "claim_status" DEFAULT 'open' NOT NULL,
	"resolution" "claim_resolution",
	"amount_minor" bigint,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"external_customer_id" text,
	"email" text,
	"phone" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatch_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"fulfillment_center_id" uuid NOT NULL,
	"adapter_key" text NOT NULL,
	"status" "dispatch_batch_status" DEFAULT 'draft' NOT NULL,
	"file_asset_id" uuid,
	"row_count" integer DEFAULT 0 NOT NULL,
	"exported_at" timestamp with time zone,
	"exported_by" uuid,
	"imported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillment_orders" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"fulfillment_center_id" uuid NOT NULL,
	"adapter_key" text NOT NULL,
	"dispatch_batch_id" uuid,
	"dispatch_row" integer,
	"external_fulfillment_id" text,
	"idempotency_key" text NOT NULL,
	"status" "fulfillment_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"request_snapshot" jsonb,
	"response_snapshot" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_orders_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "fulfillment_orders_dispatch_batch_id_dispatch_row_unique" UNIQUE("dispatch_batch_id","dispatch_row")
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status",
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"brand_product_variant_id" uuid,
	"sku_id" uuid,
	"label_id" uuid,
	"quantity" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"retail_unit_price_minor" bigint,
	"cost_unit_minor" bigint,
	"fulfillment_fee_minor" bigint,
	"status" "order_item_status" DEFAULT 'pending' NOT NULL,
	"external_line_item_id" text,
	"lot_number" text,
	"batch_code" text,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_items_qty_positive" CHECK ("order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"integration_id" uuid,
	"external_order_id" text,
	"external_order_number" text,
	"customer_id" uuid,
	"ship_to" jsonb NOT NULL,
	"bill_to" jsonb,
	"currency" char(3) NOT NULL,
	"retail_subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"retail_shipping_minor" bigint DEFAULT 0 NOT NULL,
	"retail_total_minor" bigint DEFAULT 0 NOT NULL,
	"status" "order_status" DEFAULT 'received' NOT NULL,
	"placed_at" timestamp with time zone,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hold_reason" text,
	"risk_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_integration_id_external_order_id_unique" UNIQUE("integration_id","external_order_id"),
	CONSTRAINT "orders_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"rma_number" text NOT NULL,
	"reason" text,
	"status" "return_status" DEFAULT 'requested' NOT NULL,
	"return_shipment_id" uuid,
	"resolution" text,
	"cost_bearer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "returns_rma_number_unique" UNIQUE("rma_number")
);
--> statement-breakpoint
CREATE TABLE "shipment_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"lot_number" text,
	"batch_code" text,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_items_qty_positive" CHECK ("shipment_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"fulfillment_order_id" uuid NOT NULL,
	"carrier" text NOT NULL,
	"service" text,
	"tracking_number" text,
	"tracking_url" text,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"weight_grams" integer,
	"cost_minor" bigint,
	"currency" char(3) NOT NULL,
	"label_asset_id" uuid,
	"pushed_to_store_at" timestamp with time zone,
	"status" "shipment_status" DEFAULT 'label_created' NOT NULL,
	"lot_number" text,
	"batch_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_carrier_tracking_number_unique" UNIQUE("carrier","tracking_number"),
	CONSTRAINT "shipments_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "tracking_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status_code" text NOT NULL,
	"description" text,
	"location" text,
	"raw" jsonb,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracking_events_shipment_id_occurred_at_status_code_unique" UNIQUE("shipment_id","occurred_at","status_code")
);
--> statement-breakpoint
CREATE TABLE "charges" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid,
	"kind" charge_kind NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_payment_intent_id" text,
	"status" charge_status DEFAULT 'pending_external' NOT NULL,
	"fee_schedule_id" uuid,
	"failure_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"marked_paid_by" uuid,
	"marked_paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charges_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "charges_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "charges_amount_nonneg" CHECK ("charges"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"reason" text NOT NULL,
	"order_id" uuid,
	"claim_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "credit_notes_amount_positive" CHECK ("credit_notes"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount_minor" bigint NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_lines_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"subtotal_minor" bigint NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"pdf_asset_id" uuid,
	"provider_invoice_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number"),
	CONSTRAINT "invoices_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid,
	"charge_id" uuid,
	"fee_schedule_id" uuid,
	"account" "ledger_account" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_pm_id" text NOT NULL,
	"brand" text,
	"last4" char(4),
	"exp_month" integer,
	"exp_year" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" "payment_method_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_provider_provider_pm_id_unique" UNIQUE("provider","provider_pm_id")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"reason" text,
	"provider_refund_id" text,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_subscription_id" text,
	"status" "subscription_status" NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"delta_minor" bigint NOT NULL,
	"balance_after_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"reason" text NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_transactions_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_org_id_scope_key_unique" UNIQUE("org_id","scope","key")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"channel" "notification_channel" NOT NULL,
	"template" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid,
	"type" "review_item_type" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"assignee_user_id" uuid,
	"status" "review_item_status" DEFAULT 'open' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_label_template_id_label_templates_id_fk" FOREIGN KEY ("label_template_id") REFERENCES "public"."label_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_centers" ADD CONSTRAINT "fulfillment_centers_manufacturer_id_manufacturers_id_fk" FOREIGN KEY ("manufacturer_id") REFERENCES "public"."manufacturers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_centers" ADD CONSTRAINT "fulfillment_centers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_fulfillment_center_id_fulfillment_centers_id_fk" FOREIGN KEY ("fulfillment_center_id") REFERENCES "public"."fulfillment_centers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_fulfillment_center_id_fulfillment_centers_id_fk" FOREIGN KEY ("fulfillment_center_id") REFERENCES "public"."fulfillment_centers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manufacturers" ADD CONSTRAINT "manufacturers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_sku_mappings" ADD CONSTRAINT "partner_sku_mappings_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_sku_mappings" ADD CONSTRAINT "partner_sku_mappings_manufacturer_id_manufacturers_id_fk" FOREIGN KEY ("manufacturer_id") REFERENCES "public"."manufacturers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_costs" ADD CONSTRAINT "sku_costs_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_costs" ADD CONSTRAINT "sku_costs_fulfillment_center_id_fulfillment_centers_id_fk" FOREIGN KEY ("fulfillment_center_id") REFERENCES "public"."fulfillment_centers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_inventory" ADD CONSTRAINT "brand_inventory_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_inventory" ADD CONSTRAINT "brand_inventory_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_inventory" ADD CONSTRAINT "brand_inventory_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_inventory" ADD CONSTRAINT "brand_inventory_fulfillment_center_id_fulfillment_centers_id_fk" FOREIGN KEY ("fulfillment_center_id") REFERENCES "public"."fulfillment_centers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_product_variants" ADD CONSTRAINT "brand_product_variants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_product_variants" ADD CONSTRAINT "brand_product_variants_brand_product_id_brand_products_id_fk" FOREIGN KEY ("brand_product_id") REFERENCES "public"."brand_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_product_variants" ADD CONSTRAINT "brand_product_variants_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_products" ADD CONSTRAINT "brand_products_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_products" ADD CONSTRAINT "brand_products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_products" ADD CONSTRAINT "brand_products_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_products" ADD CONSTRAINT "brand_products_primary_mockup_asset_id_assets_id_fk" FOREIGN KEY ("primary_mockup_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_logo_asset_id_assets_id_fk" FOREIGN KEY ("logo_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_brand_product_id_brand_products_id_fk" FOREIGN KEY ("brand_product_id") REFERENCES "public"."brand_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_label_template_id_label_templates_id_fk" FOREIGN KEY ("label_template_id") REFERENCES "public"."label_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_preview_asset_id_assets_id_fk" FOREIGN KEY ("preview_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_print_file_asset_id_assets_id_fk" FOREIGN KEY ("print_file_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_queue" ADD CONSTRAINT "job_queue_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sync_mappings" ADD CONSTRAINT "product_sync_mappings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sync_mappings" ADD CONSTRAINT "product_sync_mappings_brand_product_variant_id_brand_product_variants_id_fk" FOREIGN KEY ("brand_product_variant_id") REFERENCES "public"."brand_product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sync_mappings" ADD CONSTRAINT "product_sync_mappings_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_fulfillment_center_id_fulfillment_centers_id_fk" FOREIGN KEY ("fulfillment_center_id") REFERENCES "public"."fulfillment_centers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_file_asset_id_assets_id_fk" FOREIGN KEY ("file_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_exported_by_users_id_fk" FOREIGN KEY ("exported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_fulfillment_center_id_fulfillment_centers_id_fk" FOREIGN KEY ("fulfillment_center_id") REFERENCES "public"."fulfillment_centers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_dispatch_batch_id_dispatch_batches_id_fk" FOREIGN KEY ("dispatch_batch_id") REFERENCES "public"."dispatch_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_brand_product_variant_id_brand_product_variants_id_fk" FOREIGN KEY ("brand_product_variant_id") REFERENCES "public"."brand_product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_return_shipment_id_shipments_id_fk" FOREIGN KEY ("return_shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_fulfillment_order_id_fulfillment_orders_id_fk" FOREIGN KEY ("fulfillment_order_id") REFERENCES "public"."fulfillment_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_label_asset_id_assets_id_fk" FOREIGN KEY ("label_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_fee_schedule_id_fee_schedules_id_fk" FOREIGN KEY ("fee_schedule_id") REFERENCES "public"."fee_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_marked_paid_by_users_id_fk" FOREIGN KEY ("marked_paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pdf_asset_id_assets_id_fk" FOREIGN KEY ("pdf_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_fee_schedule_id_fee_schedules_id_fk" FOREIGN KEY ("fee_schedule_id") REFERENCES "public"."fee_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD CONSTRAINT "review_queue_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD CONSTRAINT "review_queue_items_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_org_id_created_at_index" ON "audit_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "memberships_org_id_index" ON "memberships" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "inventory_ledger_sku_id_fulfillment_center_id_index" ON "inventory_ledger" USING btree ("sku_id","fulfillment_center_id");--> statement-breakpoint
CREATE INDEX "sku_costs_sku_id_fulfillment_center_id_effective_from_index" ON "sku_costs" USING btree ("sku_id","fulfillment_center_id","effective_from");--> statement-breakpoint
CREATE INDEX "skus_catalog_product_id_index" ON "skus" USING btree ("catalog_product_id");--> statement-breakpoint
CREATE INDEX "assets_org_id_index" ON "assets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "brand_inventory_org_id_sku_id_index" ON "brand_inventory" USING btree ("org_id","sku_id");--> statement-breakpoint
CREATE INDEX "brand_product_variants_org_id_index" ON "brand_product_variants" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "brand_products_org_id_brand_id_index" ON "brand_products" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX "labels_org_id_index" ON "labels" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "integrations_org_id_index" ON "integrations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "job_queue_status_run_at_index" ON "job_queue" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "outbox_events_published_at_created_at_index" ON "outbox_events" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE INDEX "product_sync_mappings_org_id_index" ON "product_sync_mappings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "stores_org_id_index" ON "stores" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status_received_at_index" ON "webhook_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "claims_org_id_index" ON "claims" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "customers_org_id_brand_id_index" ON "customers" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX "fulfillment_orders_org_id_order_id_index" ON "fulfillment_orders" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "order_events_org_id_order_id_created_at_index" ON "order_events" USING btree ("org_id","order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_items_org_id_order_id_index" ON "order_items" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "orders_org_id_status_index" ON "orders" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "returns_org_id_index" ON "returns" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "shipment_items_org_id_index" ON "shipment_items" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "shipments_org_id_fulfillment_order_id_index" ON "shipments" USING btree ("org_id","fulfillment_order_id");--> statement-breakpoint
CREATE INDEX "tracking_events_org_id_index" ON "tracking_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "charges_org_id_order_id_index" ON "charges" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "credit_notes_org_id_index" ON "credit_notes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_org_id_invoice_id_index" ON "invoice_lines" USING btree ("org_id","invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_org_id_index" ON "invoices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_org_id_order_id_index" ON "ledger_entries" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "payment_methods_org_id_index" ON "payment_methods" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "refunds_org_id_index" ON "refunds" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "wallet_transactions_org_id_created_at_index" ON "wallet_transactions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_org_id_user_id_index" ON "notifications" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "review_queue_items_status_priority_index" ON "review_queue_items" USING btree ("status","priority");