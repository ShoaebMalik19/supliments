import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

function connect(url: string) {
  const client = postgres(url, { prepare: false, max: 10, onnotice: () => {} });
  return { client, db: drizzle(client, { schema }) };
}

type Connection = ReturnType<typeof connect>;
export type Db = Connection["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

let connection: Connection | undefined;

export function getDb(): Db {
  if (!connection) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    connection = connect(url);
  }
  return connection.db;
}

export async function closeDb() {
  await connection?.client.end();
  connection = undefined;
}
