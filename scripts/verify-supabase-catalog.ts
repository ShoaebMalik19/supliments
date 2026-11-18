/**
 * Read-only catalog audit of a live Supabase database: what PostgREST/GraphQL/Storage will enforce
 * is decided by these grants, roles and policies. Needs only a read-capable DATABASE_URL.
 *
 *   DATABASE_URL=… npm run verify:catalog
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

const PLATFORM_NO_POLICY = [
  "dispatch_batches",
  "feature_flags",
  "fulfillment_centers",
  "inventory",
  "inventory_ledger",
  "manufacturers",
  "partner_sku_mappings",
  "platform_admins",
  "settings",
  "suppliers",
  "webhook_events",
].sort();

const checks: [string, () => Promise<unknown>, unknown][] = [
  [
    "anon/authenticated privileges on public tables, sequences, functions",
    () => sql`
      select r, kind, obj from (
        select r, 'table' kind, t.tablename obj from unnest(array['anon','authenticated']) r, pg_tables t,
          unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        where t.schemaname = 'public' and has_table_privilege(r, format('public.%I', t.tablename), p)
        union all
        select r, 'sequence', c.relname from unnest(array['anon','authenticated']) r, pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and has_sequence_privilege(r, c.oid, 'USAGE')
        union all
        select r, 'function', p.proname from unnest(array['anon','authenticated']) r, pg_proc p
        where p.pronamespace = 'public'::regnamespace and has_function_privilege(r, p.oid, 'EXECUTE')
      ) x`,
    [],
  ],
  [
    "tables without RLS",
    () =>
      sql`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`,
    [],
  ],
  [
    "org_id tables without the app_user tenant policy",
    () => sql`
      select c.table_name from information_schema.columns c
      where c.table_schema = 'public' and c.column_name = 'org_id' and not exists (
        select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.table_name
          and 'app_user' = any(p.roles) and p.qual like '%org_id = current_org_id()%')`,
    [],
  ],
  [
    "policies granted to any role other than app_user",
    () =>
      sql`select tablename, policyname, roles from pg_policies where schemaname = 'public' and not (roles <@ array['app_user']::name[])`,
    [],
  ],
  [
    "tables with no policy (must be exactly the platform-owned, deny-by-default set)",
    async () =>
      (
        await sql`select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
          and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
          order by 1`
      ).map((r) => r.relname),
    PLATFORM_NO_POLICY,
  ],
  [
    "app_user attributes",
    () => sql`select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'app_user'`,
    [{ rolsuper: false, rolbypassrls: false, rolcanlogin: false }],
  ],
  [
    "roles that can become app_user (only the table owner)",
    async () => [
      ...new Set(
        (
          await sql`select m.rolname from pg_auth_members a join pg_roles m on m.oid = a.member
              where a.roleid = 'app_user'::regrole`
        ).map((r) => r.rolname),
      ),
    ],
    ["postgres"],
  ],
  [
    "authenticator can only become anon/authenticated/service_role",
    async () =>
      (
        await sql`select g.rolname from pg_auth_members a join pg_roles g on g.oid = a.roleid
          where a.member = 'authenticator'::regrole order by 1`
      ).map((r) => r.rolname),
    ["anon", "authenticated", "service_role"],
  ],
  [
    "views, SECURITY DEFINER functions or extensions in public (each would bypass the above)",
    () => sql`
      select 'view' k, viewname n from pg_views where schemaname = 'public'
      union all select 'matview', matviewname from pg_matviews where schemaname = 'public'
      union all select 'secdef', proname from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
      union all select 'extension', extname from pg_extension where extnamespace = 'public'::regnamespace`,
    [],
  ],
  [
    "storage.objects policies (none: only the service role reaches private files)",
    () =>
      sql`select policyname, roles from pg_policies where schemaname = 'storage' and tablename = 'objects'`,
    [],
  ],
  [
    "assets bucket is private",
    () =>
      sql`select id, public from storage.buckets where id = ${process.env.ASSETS_BUCKET ?? "assets-private"}`,
    [{ id: process.env.ASSETS_BUCKET ?? "assets-private", public: false }],
  ],
];

let failed = 0;
for (const [name, run, want] of checks) {
  const got = JSON.parse(JSON.stringify(await run()));
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`}`,
  );
}
await sql.end();
process.exit(failed ? 1 : 0);
