import { sql } from "drizzle-orm";
import { bigint, char, check, timestamp, uuid } from "drizzle-orm/pg-core";

export const pk = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuid_generate_v7()`);

export const minor = (name: string) => bigint(name, { mode: "bigint" });

export const currency = (name = "currency") => char(name, { length: 3 });

export const currencyCheck = (table: string, column = "currency") =>
  check(`${table}_${column}_iso`, sql.raw(`"${column}" ~ '^[A-Z]{3}$'`));

export const ts = (name: string) => timestamp(name, { withTimezone: true });

export const timestamps = {
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
};
