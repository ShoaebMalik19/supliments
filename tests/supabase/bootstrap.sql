-- Mirrors the parts of Supabase's role bootstrap (supabase/postgres init scripts) that decide
-- what the Data API can reach. Runs as a real superuser before our migrations.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', r);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD 'authenticator';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sb_postgres') THEN
    -- Supabase's `postgres` is not a superuser: CREATEROLE + CREATEDB + BYPASSRLS.
    CREATE ROLE sb_postgres LOGIN CREATEROLE CREATEDB BYPASSRLS PASSWORD 'sb_postgres';
  END IF;
  -- Roles are cluster-wide; if another test database already created app_user, give the
  -- Supabase-like owner the admin rights it would have had by creating it itself.
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT app_user TO sb_postgres WITH ADMIN OPTION';
  END IF;
END $$;
GRANT anon, authenticated, service_role TO authenticator;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE sb_postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE sb_postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE sb_postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
