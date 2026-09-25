import { redirect } from "next/navigation";
import { withTenant } from "@/db/tenant";
import { getActiveProduct, listActiveProducts } from "@/modules/catalog";
import { createBrandProduct, listBrands } from "@/modules/branding";
import { requireTenant, resolveTenant } from "@/modules/tenancy";
import { formatMinor } from "@/lib/format";

export const dynamic = "force-dynamic";

async function addToBrand(form: FormData) {
  "use server";
  const ctx = await requireTenant("brand:write");
  const skuIds = form.getAll("skuId").map(String);
  const bp = await withTenant(ctx.orgId, (t) =>
    createBrandProduct(ctx, t, {
      brandId: String(form.get("brandId")),
      catalogProductId: String(form.get("catalogProductId")),
      currency: String(form.get("currency")),
      variants: skuIds.map((skuId) => ({
        skuId,
        retailPriceMinor: String(form.get(`price_${skuId}`)),
      })),
    }),
  );
  redirect(`/brand-products/${bp.id}`);
}

export default async function CatalogPage() {
  const ctx = await resolveTenant();
  if (!ctx) redirect("/login");
  const { products, brands } = await withTenant(ctx.orgId, async (t) => {
    const list = await listActiveProducts(t);
    return {
      products: await Promise.all(list.map((p) => getActiveProduct(t, p.id))),
      brands: await listBrands(t),
    };
  });
  return (
    <main>
      <h1>Catalog</h1>
      {products.map(
        (p) =>
          p && (
            <section key={p.id}>
              <h2>{p.name}</h2>
              <form action={addToBrand}>
                <input type="hidden" name="catalogProductId" value={p.id} />
                <input type="hidden" name="currency" value={p.currency} />
                <select name="brandId">
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                {p.skus.map((s) => (
                  <label key={s.id}>
                    <input type="hidden" name="skuId" value={s.id} />
                    {s.sku} (cost {formatMinor(s.baseCostMinor, s.currency)}) retail in minor units:
                    <input name={`price_${s.id}`} inputMode="numeric" pattern="\d+" required />
                  </label>
                ))}
                <button type="submit">Add to brand</button>
              </form>
            </section>
          ),
      )}
    </main>
  );
}
