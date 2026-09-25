import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb } from "../src/db/client";
import { privilegedDb } from "../src/db/privileged";
import { labelTemplates } from "../src/db/schema";
import { createLabelTemplate } from "../src/modules/labels/admin";

const dir = "db/seed/label-templates";
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const json = JSON.parse(readFileSync(join(dir, file), "utf8")) as { name: string };
  const existing = await privilegedDb()
    .select({ id: labelTemplates.id })
    .from(labelTemplates)
    .where(eq(labelTemplates.name, json.name));
  if (existing.length) {
    console.log(`skip ${file}: template exists (${existing[0]!.id})`);
    continue;
  }
  const row = await createLabelTemplate(null, json);
  console.log(`seeded ${file} -> ${row.id}`);
}
await closeDb();
