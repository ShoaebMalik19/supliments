import { notFound, redirect } from "next/navigation";
import { withTenant } from "@/db/tenant";
import { downloadUrl } from "@/modules/assets";
import { getLabel, submitLabel, updateLabelDesign } from "@/modules/labels";
import { requireTenant, resolveTenant } from "@/modules/tenancy";
import { HttpError } from "@/lib/http";

export const dynamic = "force-dynamic";

const FIELD_PREFIX = "field:";

/** Runs a form action; validation errors come back as `?error=`, success goes to `next`. */
async function run(path: string, fn: () => Promise<string | void>) {
  let target = path;
  try {
    target = (await fn()) ?? path;
  } catch (e) {
    if (!(e instanceof HttpError) || e.status === 404) throw e;
    target = `${path}?error=${encodeURIComponent(e.message)}`;
  }
  redirect(target);
}

async function save(form: FormData) {
  "use server";
  const id = String(form.get("id"));
  await run(`/labels/${id}`, async () => {
    const ctx = await requireTenant("label:write");
    const designState: Record<string, string | null> = {};
    for (const [name, value] of form.entries())
      if (name.startsWith(FIELD_PREFIX) && typeof value === "string")
        designState[name.slice(FIELD_PREFIX.length)] = value.trim() || null;
    const out = await withTenant(ctx.orgId, (t) => updateLabelDesign(ctx, t, id, { designState }));
    if (!out) throw new HttpError(404, "Not found");
    return `/labels/${out.label.id}`;
  });
}

async function submit(form: FormData) {
  "use server";
  const id = String(form.get("id"));
  await run(`/labels/${id}`, async () => {
    const ctx = await requireTenant("label:write");
    await withTenant(ctx.orgId, (t) => submitLabel(ctx, t, id));
  });
}

export default async function LabelPage({
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
    const label = await getLabel(t, id);
    if (!label) return null;
    const preview = label.previewAssetId ? await downloadUrl(t, label.previewAssetId) : null;
    return { label, previewUrl: preview?.url ?? null };
  });
  if (!data) notFound();
  const { label, previewUrl } = data;
  const state = label.designState;

  return (
    <main>
      <h1>
        Label v{label.version} — {label.status}
      </h1>
      <p>
        Template: {label.template.name} ({label.template.printSpec.trimWidthMm}×
        {label.template.printSpec.trimHeightMm} mm)
      </p>
      <p>
        <a href={`/brand-products/${label.brandProductId}`}>Back to product</a>
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {label.rejectionReason ? <p>Rejected: {label.rejectionReason}</p> : null}
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt="Label preview" />
      ) : null}

      <form action={save}>
        <input type="hidden" name="id" value={label.id} />
        {label.template.editableFields.map((f) => (
          <p key={f.key}>
            <label>
              {f.label}
              {f.required ? " *" : ""}{" "}
              {f.type === "text" ? (
                <input
                  name={`${FIELD_PREFIX}${f.key}`}
                  maxLength={f.maxLength}
                  defaultValue={state[f.key] ?? ""}
                />
              ) : f.type === "color" ? (
                <input
                  type="color"
                  name={`${FIELD_PREFIX}${f.key}`}
                  defaultValue={state[f.key] ?? f.default}
                />
              ) : (
                <input
                  name={`${FIELD_PREFIX}${f.key}`}
                  placeholder="Logo asset id (upload via /api/assets/uploads)"
                  defaultValue={state[f.key] ?? ""}
                />
              )}
            </label>
          </p>
        ))}
        <p>Locked panels: {label.template.lockedPanels.map((p) => p.label).join(", ")}</p>
        <button type="submit">
          {label.status === "draft" ? "Save" : "Save as new draft version"}
        </button>
      </form>

      {label.status === "draft" ? (
        <form action={submit}>
          <input type="hidden" name="id" value={label.id} />
          <button type="submit">Submit for review</button>
        </form>
      ) : null}
    </main>
  );
}
