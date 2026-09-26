/**
 * RLS and grants under Supabase's role model rather than a superuser test connection:
 * migrations run as a non-superuser owner (like Supabase's `postgres`), Supabase's default
 * privileges are in place, and the Data API roles (anon/authenticated via authenticator) are
 * probed directly. Uses its own database so it never disturbs the main test schema.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const DB = "app_test_supabase";
const admin = new URL(process.env.DATABASE_URL!);
const urlFor = (user: string, password: string) => {
  const u = new URL(admin);
  u.username = user;
  u.password = password;
  u.pathname = `/${DB}`;
  return u.toString();
};

let su: postgres.Sql;
let owner: postgres.Sql;
let authenticator: postgres.Sql;

beforeAll(async () => {
  const root = postgres(admin.toString(), { onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.unsafe(readFileSync(join(import.meta.dirname, "bootstrap.sql"), "utf8"));
  await root.unsafe(`CREATE DATABASE ${DB} OWNER sb_postgres`);
  await root.end();

  const dbUrl = new URL(admin);
  dbUrl.pathname = `/${DB}`;
  su = postgres(dbUrl.toString(), { onnotice: () => {} });
  await su.unsafe(readFileSync(join(import.meta.dirname, "bootstrap.sql"), "utf8"));

  owner = postgres(urlFor("sb_postgres", "sb_postgres"), { onnotice: () => {}, max: 1 });
  await migrate(drizzle(owner), { migrationsFolder: "db/migrations" });
  authenticator = postgres(urlFor("authenticator", "authenticator"), {
    onnotice: () => {},
    max: 1,
  });
}, 120_000);

afterAll(async () => {
  await Promise.all([owner?.end(), authenticator?.end(), su?.end()]);
});

const tables = () =>
  su<{ t: string }[]>`select tablename as t from pg_tables where schemaname = 'public'`;

describe("Supabase Data API roles cannot reach tenant data", () => {
  it("migrations ran as a non-superuser owner", async () => {
    const [r] = await su`select rolsuper, rolbypassrls from pg_roles where rolname = 'sb_postgres'`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: true });
    const [o] = await su`select tableowner from pg_tables where tablename = 'orders'`;
    expect(o!.tableowner).toBe("sb_postgres");
  });

  it("anon and authenticated hold no privilege on any public table", async () => {
    const leaks = await su`
      select r.rolname, t.tablename, p.priv from pg_tables t
      cross join (values ('anon'), ('authenticated')) r(rolname)
      cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
      where t.schemaname = 'public'
        and has_table_privilege(r.rolname, format('public.%I', t.tablename), p.priv)`;
    expect(leaks).toEqual([]);
    expect((await tables()).length).toBeGreaterThan(40);
  });

  it("anon and authenticated cannot execute any function in public (PostgREST /rpc)", async () => {
    const callable = await su`
      select r.rolname, p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated')) r(rolname)
      where n.nspname = 'public' and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`;
    expect(callable).toEqual([]);
  });

  it("a signed-in user's JWT role sees nothing, even with a forged app.current_org", async () => {
    const [org] = await owner`insert into organizations (name) values ('Victim') returning id`;
    await owner`insert into brands (org_id, name, slug) values (${org!.id}, 'B', 'b')`;
    const attempt = authenticator.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true)`;
      await tx`select set_config('app.current_org', ${org!.id}, true)`;
      return tx`select * from brands`;
    });
    await expect(attempt).rejects.toThrow(/permission denied/);
  });

  it("the Data API cannot assume the tenant role (a JWT claiming role app_user fails)", async () => {
    await expect(authenticator.begin((tx) => tx`set local role app_user`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it("a table added later by the owner does not inherit Data API grants", async () => {
    await owner`create table public.later_table (id int)`;
    const [g] = await su`select has_table_privilege('anon', 'public.later_table', 'SELECT') as a,
      has_table_privilege('authenticated', 'public.later_table', 'SELECT') as b`;
    expect(g).toEqual({ a: false, b: false });
    await owner`drop table public.later_table`;
  });
});

describe("the app's tenant path works under a non-superuser owner", () => {
  it("SET LOCAL ROLE app_user isolates orgs; the owner (privileged path) sees all", async () => {
    const [a] = await owner`insert into organizations (name) values ('A') returning id`;
    const [b] = await owner`insert into organizations (name) values ('B') returning id`;
    await owner`insert into brands (org_id, name, slug) values (${a!.id}, 'A', 'a'), (${b!.id}, 'B', 'b')`;
    const seen = await owner.begin(async (tx) => {
      await tx`set local role app_user`;
      await tx`select set_config('app.current_org', ${a!.id}, true)`;
      return tx<{ org_id: string }[]>`select org_id from brands`;
    });
    expect(new Set(seen.map((r) => r.org_id))).toEqual(new Set([a!.id]));
    const all =
      await owner`select distinct org_id from brands where org_id in (${a!.id}, ${b!.id})`;
    expect(all).toHaveLength(2);
  });

  it("app_user can still use the functions its defaults and policies need", async () => {
    const [a] = await owner`insert into organizations (name) values ('C') returning id`;
    const row = await owner.begin(async (tx) => {
      await tx`set local role app_user`;
      await tx`select set_config('app.current_org', ${a!.id}, true)`;
      return tx`insert into brands (org_id, name, slug) values (${a!.id}, 'C', 'c') returning id`;
    });
    expect(row).toHaveLength(1);
  });

  it("service_role bypasses RLS by design (server-only key); documented, not accidental", async () => {
    const [r] = await su`select rolbypassrls from pg_roles where rolname = 'service_role'`;
    expect(r!.rolbypassrls).toBe(true);
  });
});
