import { randomUUID } from "node:crypto";
import { privilegedDb } from "@/db/privileged";
import { brands, memberships, organizations, users } from "@/db/schema";

export async function createUser(email = `${randomUUID()}@test.local`) {
  const [user] = await privilegedDb().insert(users).values({ id: randomUUID(), email }).returning();
  return user!;
}

export async function createTenant(name = "Org") {
  const db = privilegedDb();
  const owner = await createUser();
  const [org] = await db.insert(organizations).values({ name }).returning();
  await db.insert(memberships).values({ orgId: org!.id, userId: owner.id, role: "owner" });
  const [brand] = await db
    .insert(brands)
    .values({ orgId: org!.id, name: `${name} Brand`, slug: `brand-${randomUUID()}` })
    .returning();
  return { org: org!, owner, brand: brand! };
}

export async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { cause?: { message?: string }; message: string };
    return err.cause?.message ?? err.message;
  }
  throw new Error("expected query to fail");
}
