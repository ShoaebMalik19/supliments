import { afterAll } from "vitest";
import { closeDb } from "@/db/client";

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/app_test";
process.env.INTEGRATION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.SHOPIFY_API_KEY ??= "test-api-key";
process.env.SHOPIFY_API_SECRET ??= "test-api-secret";

afterAll(async () => {
  await closeDb();
});
