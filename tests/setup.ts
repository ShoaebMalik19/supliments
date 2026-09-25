import { afterAll } from "vitest";
import { closeDb } from "@/db/client";

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/app_test";

afterAll(async () => {
  await closeDb();
});
