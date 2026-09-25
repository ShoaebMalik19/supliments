import { notFound } from "next/navigation";
import { createSku, getProduct, updateProduct, updateSku } from "@/modules/catalog/admin";
import { adminOrNotFound, formAction, formFields } from "../../../guard";

export const dynamic = "force-dynamic";

const pathFor = (id: string) => `/admin/catalog/products/${id}`;

async function saveProduct(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  const id = String(form.get("id"));
  await formAction(pathFor(id), () =>
    updateProduct(
      admin,
      id,
      formFields(form, ["name", "description", "status", "defaultMsrpMinor", "currency"]),
    ),
  );
}

async function addSku(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  const catalogProductId = String(form.get("catalogProductId"));
  await formAction(pathFor(catalogProductId), () =>
    createSku(admin, {
      catalogProductId,
      ...formFields(form, ["sku", "baseCostMinor", "currency", "barcode"]),
    }),
  );
}

async function saveSku(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  await formAction(pathFor(String(form.get("productId"))), () =>
    updateSku(admin, String(form.get("id")), {
      ...formFields(form, ["baseCostMinor", "currency"]),
      isActive: form.get("isActive") === "on",
    }),
  );
}

export default async function ProductAdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const admin = await adminOrNotFound();
  const { id } = await params;
  const { error } = await searchParams;
  const product = await getProduct(admin, id);
  if (!product) notFound();
  return (
    <main>
      <p>
        <a href="/admin/catalog">Catalog</a>
      </p>
      <h1>{product.name}</h1>
      {error && <p role="alert">{error}</p>}
      <form action={saveProduct}>
        <input type="hidden" name="id" value={product.id} />
        <input name="name" defaultValue={product.name} required />
        <select name="status" defaultValue={product.status}>
          <option value="draft">draft</option>
          <option value="active">active</option>
          <option value="discontinued">discontinued</option>
        </select>
        <input
          name="defaultMsrpMinor"
          defaultValue={product.defaultMsrpMinor?.toString() ?? ""}
          inputMode="numeric"
          placeholder="MSRP (minor units)"
        />
        <input name="currency" defaultValue={product.currency} required />
        <textarea name="description" defaultValue={product.description ?? ""} />
        <button type="submit">Save product</button>
      </form>

      <h2>SKUs</h2>
      <table>
        <tbody>
          {product.skus.map((s) => (
            <tr key={s.id}>
              <td>{s.sku}</td>
              <td>
                <form action={saveSku}>
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="productId" value={product.id} />
                  <input
                    name="baseCostMinor"
                    defaultValue={s.baseCostMinor.toString()}
                    inputMode="numeric"
                  />
                  <input name="currency" defaultValue={s.currency} />
                  <label>
                    <input type="checkbox" name="isActive" defaultChecked={s.isActive} /> active
                  </label>
                  <button type="submit">Save</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form action={addSku}>
        <input type="hidden" name="catalogProductId" value={product.id} />
        <input name="sku" placeholder="SKU code" required />
        <input
          name="baseCostMinor"
          placeholder="Base cost (minor units)"
          inputMode="numeric"
          required
        />
        <input name="currency" defaultValue="USD" required />
        <input name="barcode" placeholder="Barcode" />
        <button type="submit">Add SKU</button>
      </form>
    </main>
  );
}
