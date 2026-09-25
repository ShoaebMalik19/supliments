SELECT enable_tenant_rls('oauth_states', 'SELECT, INSERT, UPDATE');
--> statement-breakpoint
CREATE POLICY catalog_read ON sku_costs FOR SELECT TO app_user USING (true);
--> statement-breakpoint
GRANT SELECT ON sku_costs TO app_user;
--> statement-breakpoint
CREATE UNIQUE INDEX review_queue_items_one_open_per_entity
  ON review_queue_items (type, entity_id) WHERE status IN ('open', 'in_progress');
