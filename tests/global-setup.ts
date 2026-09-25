import postgres from "postgres";
import { execSync } from "node:child_process";

export default async function setup() {
  process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/app_test";
  const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
  await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE;");
  await sql.unsafe("CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC;");
  await sql.end();
  execSync("npx tsx scripts/migrate.ts", { stdio: "inherit", env: process.env });
}
