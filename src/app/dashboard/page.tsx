import Link from "next/link";
import { redirect } from "next/navigation";
import { organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { revalidatePath } from "next/cache";
import { listBrands, renameBrand } from "@/modules/branding";
import {
  can,
  orgMembers,
  renameOrganization,
  requireTenant,
  resolveTenant,
} from "@/modules/tenancy";

export const dynamic = "force-dynamic";

async function rename(form: FormData) {
  "use server";
  const ctx = await requireTenant("org:update");
  await withTenant(ctx.orgId, async (t) => {
    await renameOrganization(ctx, t, form.get("orgName"));
    const brandId = String(form.get("brandId") ?? "");
    if (brandId) await renameBrand(ctx, t, brandId, { name: form.get("brandName") });
  });
  revalidatePath("/dashboard");
}

export default async function DashboardPage() {
  const ctx = await resolveTenant();
  if (!ctx) redirect("/login");
  const { org, members, brand } = await withTenant(ctx.orgId, async (t) => {
    const [org] = await t.tx.select().from(organizations);
    return { org, members: await orgMembers(t), brand: (await listBrands(t))[0] ?? null };
  });
  return (
    <main>
      <h1>{org?.name}</h1>
      <p>
        Signed in as {ctx.email} ({ctx.role})
      </p>
      <p>
        <Link href="/catalog">Catalog</Link> · <Link href="/orders">Orders</Link> ·{" "}
        <Link href="/settings/stores">Store connections</Link>
      </p>
      {can(ctx.role, "org:update") && (
        <form action={rename}>
          <h2>Names</h2>
          <label>
            Organization <input name="orgName" defaultValue={org?.name} minLength={2} required />
          </label>
          {brand && (
            <label>
              <input type="hidden" name="brandId" value={brand.id} />
              Brand (shown to your customers){" "}
              <input name="brandName" defaultValue={brand.name} required />
            </label>
          )}
          <button type="submit">Save</button>
        </form>
      )}
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
