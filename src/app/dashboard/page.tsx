import { redirect } from "next/navigation";
import { organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { orgMembers, resolveTenant } from "@/modules/tenancy";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const ctx = await resolveTenant();
  if (!ctx) redirect("/login");
  const { org, members } = await withTenant(ctx.orgId, async (t) => {
    const [org] = await t.tx.select().from(organizations);
    return { org, members: await orgMembers(t) };
  });
  return (
    <main>
      <h1>{org?.name}</h1>
      <p>
        Signed in as {ctx.email} ({ctx.role})
      </p>
      <h2>Members</h2>
      <ul>
        {members.map((m) => (
          <li key={m.id}>
            {m.email} — {m.role}
          </li>
        ))}
      </ul>
      <form action="/auth/logout" method="post">
        <button type="submit">Log out</button>
      </form>
    </main>
  );
}
