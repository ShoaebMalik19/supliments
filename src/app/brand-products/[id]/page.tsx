import { notFound, redirect } from "next/navigation";
import { withTenant } from "@/db/tenant";
import { getBrandProduct } from "@/modules/branding";
import { createLabelDraft, listLabels } from "@/modules/labels";
import { requireTenant, resolveTenant } from "@/modules/tenancy";
import { formatMinor } from "@/lib/format";
import { HttpError } from "@/lib/http";

export const dynamic = "force-dynamic";

async function newLabel(form: FormData) {
  "use server";
  const id = String(form.get("id"));
  let target: string;
  try {
    const ctx = await requireTenant("label:write");
    const label = await withTenant(ctx.orgId, (t) => createLabelDraft(ctx, t, id, {}));
    if (!label) notFound();
    target = `/labels/${label.id}`;
  } catch (e) {
    if (!(e instanceof HttpError) || e.status === 404) throw e;
    target = `/brand-products/${id}?error=${encodeURIComponent(e.message)}`;
  }
  redirect(target);
}

export default async function BrandProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const ctx = await resolveTenant();
  if (!ctx) redirect("/login");
  const { id } = await params;
  const { error } = await searchParams;
  const data = await withTenant(ctx.orgId, async (t) => {
    const bp = await getBrandProduct(t, id);
    return bp && { bp, labels: await listLabels(t, id) };
  });
  if (!data) notFound();
  const { bp, labels } = data;
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
      <h2>Labels</h2>
      {error ? <p role="alert">{error}</p> : null}
      <ul>
        {labels.map((l) => (
          <li key={l.id}>
            <a href={`/labels/${l.id}`}>
              v{l.version} — {l.status}
            </a>
          </li>
        ))}
      </ul>
      <form action={newLabel}>
        <input type="hidden" name="id" value={bp.id} />
        <button type="submit">Create label draft</button>
      </form>
    </main>
  );
}
