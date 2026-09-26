import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db/tenant";
import { listBrands } from "@/modules/branding";
import { disconnectIntegration, listIntegrations } from "@/modules/integrations";
import { can, requireTenant, resolveTenant } from "@/modules/tenancy";

export const dynamic = "force-dynamic";

async function disconnect(form: FormData) {
  "use server";
  const ctx = await requireTenant("org:update");
  await withTenant(ctx.orgId, (t) => disconnectIntegration(ctx, t, String(form.get("id"))));
  revalidatePath("/settings/stores");
}

const STATUS_TEXT = {
  connected: "Connected — orders sync automatically.",
  needs_reauth:
    "Needs re-authorization: Shopify rejected our token. Pushes are paused until you reconnect.",
  disconnected:
    "Disconnected — nothing syncs. Reconnect to resume; history and product links are kept.",
} as const;

export default async function StoresPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const ctx = await resolveTenant();
  if (!ctx) redirect("/login");
  const { error } = await searchParams;
  const { stores, brands } = await withTenant(ctx.orgId, async (t) => ({
    stores: await listIntegrations(t),
    brands: await listBrands(t),
  }));
  const manage = can(ctx.role, "org:update");
  const installUrl = (shop: string, brandId: string | null) =>
    `/api/integrations/shopify/install?${new URLSearchParams({ shop, ...(brandId ? { brandId } : {}) })}`;
  return (
    <main>
      <h1>Store connections</h1>
      {error && <p role="alert">{error}</p>}
      {stores.some((s) => s.status === "needs_reauth") && (
        <p role="alert">
          A store needs re-authorization. Fulfillment and tracking updates are paused for it.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Store</th>
            <th>Status</th>
            <th>Connected</th>
            <th>Orders synced through</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {stores.map((s) => (
            <tr key={s.id}>
              <td>
                {s.provider}: {s.domain}
              </td>
              <td>{STATUS_TEXT[s.status]}</td>
              <td>{s.installedAt?.toISOString() ?? "—"}</td>
              <td>{s.ordersSyncedThrough?.toISOString() ?? "never"}</td>
              <td>
                {manage && s.provider === "shopify" && s.domain && s.status !== "connected" && (
                  <a href={installUrl(s.domain, s.brandId)}>Reconnect</a>
                )}
                {manage && s.status !== "disconnected" && (
                  <form action={disconnect}>
                    <input type="hidden" name="id" value={s.id} />
                    <button type="submit">Disconnect</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
          {stores.length === 0 && (
            <tr>
              <td colSpan={5}>No stores connected yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      {manage && (
        <>
          <h2>Connect a Shopify store</h2>
          <form action="/api/integrations/shopify/install" method="get">
            <label>
              Shop domain <input name="shop" placeholder="your-store.myshopify.com" required />
            </label>
            <label>
              Brand{" "}
              <select name="brandId">
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Connect</button>
          </form>
        </>
      )}
    </main>
  );
}
