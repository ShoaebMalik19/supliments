import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, getDb } from "../src/db/client";

await migrate(getDb(), { migrationsFolder: "db/migrations" });
await closeDb();
console.log("migrations applied");
