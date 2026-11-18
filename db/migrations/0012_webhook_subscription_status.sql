ALTER TABLE "integrations" ADD COLUMN "webhooks_subscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "webhooks_error" text;