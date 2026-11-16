ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "notifications_status_created_at_index" ON "notifications" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key");