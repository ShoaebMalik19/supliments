import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import {
  auditLogs,
  brandProducts,
  catalogProducts,
  labelTemplates,
  labels,
  ledgerEntries,
  orderItems,
  orders,
} from "@/db/schema";
import { createTenant, pgError } from "./helpers";

const db = () => privilegedDb();
const rows = async <T>(q: ReturnType<typeof sql>) => (await db().execute(q)) as unknown as T[];

describe("RLS coverage (CI gate for new tables)", () => {
  it("every public table has row level security enabled", async () => {
    const missing = await rows<{ relname: string }>(sql`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(missing.map((r) => r.relname)).toEqual([]);
  });

  it("every table with org_id has a tenant policy on current_org_id() for app_user", async () => {
    const missing = await rows<{ table_name: string }>(sql`
      select c.table_name from information_schema.columns c
      where c.table_schema = 'public' and c.column_name = 'org_id'
        and not exists (
          select 1 from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.table_name
            and 'app_user' = any(p.roles)
            and p.qual like '%org_id = current_org_id()%')`);
    expect(missing.map((r) => r.table_name)).toEqual([]);
  });

  it("app_user cannot bypass RLS and owns nothing", async () => {
    const [role] = await rows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = 'app_user'`,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await rows(sql`select 1 from pg_tables where tableowner = 'app_user'`);
    expect(owned).toHaveLength(0);
  });

  it("supabase anon/authenticated roles have no table grants", async () => {
    const grants = await rows(sql`
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon', 'authenticated')`);
    expect(grants).toHaveLength(0);
  });
});

describe("money rule", () => {
  it("every *_minor column is bigint and its table has an ISO currency column", async () => {
    const bad = await rows<{ table_name: string; column_name: string }>(sql`
      select c.table_name, c.column_name from information_schema.columns c
      where c.table_schema = 'public' and c.column_name like '%\_minor'
        and (c.data_type <> 'bigint' or not exists (
          select 1 from information_schema.columns cc
          where cc.table_schema = 'public' and cc.table_name = c.table_name
            and (cc.column_name = 'currency' or cc.column_name like '%\_currency')
            and cc.data_type = 'character' and cc.character_maximum_length = 3))`);
    expect(bad).toEqual([]);
  });

  it("no floating point or numeric columns exist", async () => {
    const bad = await rows(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type in ('real', 'double precision', 'numeric', 'money')`);
    expect(bad).toEqual([]);
  });

  it("rejects non-ISO currency codes", async () => {
    const { org, brand } = await createTenant();
    const msg = await pgError(
      db().insert(orders).values({ orgId: org.id, brandId: brand.id, shipTo: {}, currency: "usd" }),
    );
    expect(msg).toMatch(/orders_currency_iso/);
  });
});

describe("constraints", () => {
  it("generates UUID v7 primary keys", async () => {
    const { org } = await createTenant();
    expect(org.id[14]).toBe("7");
  });

  it("order item quantity must be positive", async () => {
    const { org, brand } = await createTenant();
    const [order] = await db()
      .insert(orders)
      .values({ orgId: org.id, brandId: brand.id, shipTo: {}, currency: "USD" })
      .returning();
    const msg = await pgError(
      db()
        .insert(orderItems)
        .values({ orgId: org.id, orderId: order!.id, quantity: 0, currency: "USD" }),
    );
    expect(msg).toMatch(/order_items_qty_positive/);
  });

  it("orders are unique per (integration, external order id)", async () => {
    const { org, brand } = await createTenant();
    const [integ] = await db().execute(sql`
      insert into integrations (org_id, provider, external_shop_id)
      values (${org.id}, 'shopify', ${randomUUID()}) returning id`);
    const base = {
      orgId: org.id,
      brandId: brand.id,
      shipTo: {},
      currency: "USD",
      integrationId: (integ as { id: string }).id,
      externalOrderId: "1001",
    };
    await db().insert(orders).values(base);
    expect(await pgError(db().insert(orders).values(base))).toMatch(/unique/);
  });

  it("append-only tables reject update, delete and truncate", async () => {
    const { org } = await createTenant();
    const [row] = await db()
      .insert(auditLogs)
      .values({ orgId: org.id, actorType: "system", action: "test" })
      .returning();
    expect(await pgError(db().update(auditLogs).set({ action: "x" }))).toMatch(/append-only/);
    expect(await pgError(db().delete(auditLogs))).toMatch(/append-only/);
    expect(await pgError(db().execute(sql`truncate ledger_entries`))).toMatch(/append-only/);
    expect(row!.id).toBeTruthy();
  });

  it("tenant role cannot update ledger entries even in its own org", async () => {
    const { org } = await createTenant();
    await withTenant(org.id, (t) =>
      t.insert(ledgerEntries, { account: "cogs", amountMinor: 1250n, currency: "USD" }),
    );
    const msg = await pgError(
      withTenant(org.id, (t) => t.tx.update(ledgerEntries).set({ memo: "edit" })),
    );
    expect(msg).toMatch(/permission denied/);
  });

  it("approved labels are immutable", async () => {
    const { org, brand } = await createTenant();
    const [product] = await db()
      .insert(catalogProducts)
      .values({ name: "Creatine", currency: "USD" })
      .returning();
    const [template] = await db()
      .insert(labelTemplates)
      .values({ name: "T", printSpec: {}, catalogProductId: product!.id })
      .returning();
    const [bp] = await db()
      .insert(brandProducts)
      .values({
        orgId: org.id,
        brandId: brand.id,
        catalogProductId: product!.id,
        title: "X",
        retailPriceMinor: 2999n,
        currency: "USD",
      })
      .returning();
    const [label] = await db()
      .insert(labels)
      .values({
        orgId: org.id,
        brandId: brand.id,
        brandProductId: bp!.id,
        labelTemplateId: template!.id,
        version: 1,
        status: "approved",
      })
      .returning();
    const q = db()
      .update(labels)
      .set({ designState: { text: "changed" } });
    expect(await pgError(q)).toMatch(/immutable/);
    await db()
      .update(labels)
      .set({ status: "superseded" })
      .where(sql`id = ${label!.id}`);
  });
});
