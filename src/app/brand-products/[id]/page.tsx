import { notFound, redirect } from "next/navigation";
import { withTenant } from "@/db/tenant";
import { getBrandProduct } from "@/modules/branding";
import { resolveTenant } from "@/modules/tenancy";
import { formatMinor } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function BrandProductPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveTenant();
  if (!ctx) redirect("/login");
  const { id } = await params;
  const bp = await withTenant(ctx.orgId, (t) => getBrandProduct(t, id));
  if (!bp) notFound();
  return (
    <main>
      <h1>{bp.title}</h1>
      <p>Status: {bp.status}</p>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Retail</th>
            <th>Our cost (1-unit order)</th>
            <th>Margin</th>
          </tr>
        </thead>
        <tbody>
          {bp.variants.map((v) => (
            <tr key={v.id}>
              <td>{v.sku}</td>
              <td>{formatMinor(v.retailPriceMinor, v.currency)}</td>
              <td>{v.margin ? formatMinor(v.margin.cost.totalMinor, v.currency) : "n/a"}</td>
              <td>
                {v.margin
                  ? `${formatMinor(v.margin.marginMinor, v.currency)} (${(v.margin.marginBps ?? 0) / 100}%)`
                  : "no fee schedule"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
