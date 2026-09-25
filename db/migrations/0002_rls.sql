DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
GRANT app_user TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_user;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_org', true), '')::uuid
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enable_tenant_rls(tbl regclass, privileges text DEFAULT 'SELECT, INSERT, UPDATE, DELETE')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s TO app_user USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
    tbl);
  EXECUTE format('GRANT %s ON %s TO app_user', privileges, tbl);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_approved_label() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' AND (
       NEW.design_state IS DISTINCT FROM OLD.design_state
    OR NEW.print_file_asset_id IS DISTINCT FROM OLD.print_file_asset_id
    OR NEW.preview_asset_id IS DISTINCT FROM OLD.preview_asset_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.label_template_id IS DISTINCT FROM OLD.label_template_id
    OR NEW.status NOT IN ('approved', 'superseded')) THEN
    RAISE EXCEPTION 'approved label % is immutable', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER labels_immutable_when_approved BEFORE UPDATE ON labels
  FOR EACH ROW EXECUTE FUNCTION protect_approved_label();
--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'updated_at' LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
                   r.table_name || '_touch_updated_at', r.table_name);
  END LOOP;

  FOR r IN SELECT unnest(ARRAY['audit_logs','order_events','ledger_entries','wallet_transactions','inventory_ledger']) AS t LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation()',
                   r.t || '_append_only', r.t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()',
                   r.t || '_no_truncate', r.t);
  END LOOP;

  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\_\_%' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;
--> statement-breakpoint
SELECT enable_tenant_rls(t) FROM unnest(ARRAY[
  'memberships','invitations','api_keys','brands','brand_products','brand_product_variants',
  'labels','brand_inventory','integrations','stores','product_sync_mappings','customers',
  'orders','order_items','fulfillment_orders','shipments','shipment_items','tracking_events',
  'returns','claims','subscriptions','charges','payment_methods','invoices','invoice_lines',
  'credit_notes','refunds','notifications','idempotency_keys'
]::regclass[]) AS t;
--> statement-breakpoint
SELECT enable_tenant_rls(t, 'SELECT, INSERT') FROM unnest(ARRAY[
  'order_events','ledger_entries','wallet_transactions'
]::regclass[]) AS t;
--> statement-breakpoint
SELECT enable_tenant_rls('audit_logs', 'SELECT, INSERT');
--> statement-breakpoint
SELECT enable_tenant_rls('review_queue_items', 'SELECT');
--> statement-breakpoint
SELECT enable_tenant_rls(t, 'INSERT') FROM unnest(ARRAY['job_queue','outbox_events']::regclass[]) AS t;
--> statement-breakpoint
SELECT enable_tenant_rls('assets');
--> statement-breakpoint
CREATE POLICY platform_assets_read ON assets FOR SELECT TO app_user USING (org_id IS NULL);
--> statement-breakpoint
CREATE POLICY own_org ON organizations TO app_user USING (id = current_org_id()) WITH CHECK (id = current_org_id());
--> statement-breakpoint
GRANT SELECT, UPDATE (name, country, billing_email, settings) ON organizations TO app_user;
--> statement-breakpoint
CREATE POLICY org_members ON users FOR SELECT TO app_user USING (
  EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.org_id = current_org_id()));
--> statement-breakpoint
GRANT SELECT (id, email, name) ON users TO app_user;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['categories','catalog_products','skus','label_templates','plans','fee_schedules'] LOOP
    EXECUTE format('CREATE POLICY catalog_read ON %I FOR SELECT TO app_user USING (true)', t);
    EXECUTE format('GRANT SELECT ON %I TO app_user', t);
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
