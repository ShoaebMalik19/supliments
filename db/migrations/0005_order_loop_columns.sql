CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"shop" text NOT NULL,
	"state_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
ALTER TABLE "label_templates" ADD COLUMN "mockup_spec" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "label_templates" ADD COLUMN "is_placeholder" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "default_fulfillment_center_id" uuid;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "mockup_asset_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "orders_synced_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_states_org_id_index" ON "oauth_states" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_default_fulfillment_center_id_fulfillment_centers_id_fk" FOREIGN KEY ("default_fulfillment_center_id") REFERENCES "public"."fulfillment_centers"("id") ON DELETE no action ON UPDATE no action;