import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import { getDb, type Tx } from "./client";

type TenantTable = PgTable & { id: PgColumn; orgId: PgColumn };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantDb {
  constructor(
    readonly tx: Tx,
    readonly orgId: string,
  ) {}

  async list<T extends TenantTable>(table: T, where?: SQL): Promise<T["$inferSelect"][]> {
    return (await this.tx
      .select()
      .from(table as PgTable)
      .where(and(eq(table.orgId, this.orgId), where))) as T["$inferSelect"][];
  }

  async find<T extends TenantTable>(table: T, id: string): Promise<T["$inferSelect"] | null> {
    if (!UUID_RE.test(id)) return null;
    const rows = await this.list(table, eq(table.id, id));
    return rows[0] ?? null;
  }

  async insert<T extends TenantTable>(
    table: T,
    values: Omit<T["$inferInsert"], "orgId">,
  ): Promise<T["$inferSelect"]> {
    const rows = (await this.tx
      .insert(table)
      .values({ ...values, orgId: this.orgId } as T["$inferInsert"])
      .returning()) as T["$inferSelect"][];
    return rows[0]!;
  }

  async update<T extends TenantTable>(
    table: T,
    id: string,
    values: PgUpdateSetSource<T>,
  ): Promise<T["$inferSelect"] | null> {
    if (!UUID_RE.test(id)) return null;
    const rows = (await this.tx
      .update(table)
      .set(values)
      .where(and(eq(table.id, id), eq(table.orgId, this.orgId)))
      .returning()) as T["$inferSelect"][];
    return rows[0] ?? null;
  }

  async remove<T extends TenantTable>(table: T, id: string): Promise<boolean> {
    if (!UUID_RE.test(id)) return false;
    const rows = await this.tx
      .delete(table)
      .where(and(eq(table.id, id), eq(table.orgId, this.orgId)))
      .returning({ id: table.id });
    return rows.length > 0;
  }
}

export async function withTenant<R>(orgId: string, fn: (t: TenantDb) => Promise<R>): Promise<R> {
  if (!UUID_RE.test(orgId)) throw new Error("withTenant: invalid org id");
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`set local role app_user`);
    await tx.execute(sql`select set_config('app.current_org', ${orgId}, true)`);
    return fn(new TenantDb(tx, orgId));
  });
}
