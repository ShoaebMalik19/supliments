import { getDb, type Db } from "./client";

/** Bypasses RLS (runs as the table-owner role). Every cross-tenant use must be audit-logged. */
export function privilegedDb(): Db {
  return getDb();
}
