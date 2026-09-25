import {
  createCategory,
  createProduct,
  listCategories,
  listProducts,
} from "@/modules/catalog/admin";
import { adminOrNotFound, formAction, formFields } from "../guard";

export const dynamic = "force-dynamic";

const PATH = "/admin/catalog";

async function addCategory(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  await formAction(PATH, () =>
    createCategory(admin, formFields(form, ["name", "slug", "parentId"])),
  );
}

async function addProduct(form: FormData) {
  "use server";
  const admin = await adminOrNotFound();
  await formAction(PATH, () =>
    createProduct(
      admin,
      formFields(form, [
        "name",
        "categoryId",
        "description",
        "mode",
        "defaultMsrpMinor",
        "currency",
      ]),
    ),
  );
}

export default async function CatalogAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const admin = await adminOrNotFound();
  const { error } = await searchParams;
  const [cats, products] = await Promise.all([listCategories(admin), listProducts(admin)]);
  return (
    <main>
      <h1>Admin — catalog</h1>
      <p>
        <a href="/admin">Organizations</a>
      </p>
      {error && <p role="alert">{error}</p>}

      <h2>Categories</h2>
      <table>
        <tbody>
          {cats.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.slug}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form action={addCategory}>
        <input name="name" placeholder="Name" required />
        <input name="slug" placeholder="slug" required />
        <select name="parentId" defaultValue="">
          <option value="">(no parent)</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="submit">Add category</button>
      </form>

      <h2>Products</h2>
      <table>
        <tbody>
          {products.map((p) => (
            <tr key={p.id}>
              <td>
                <a href={`${PATH}/products/${p.id}`}>{p.name}</a>
              </td>
              <td>{p.status}</td>
              <td>{p.mode}</td>
              <td>
                {p.defaultMsrpMinor?.toString() ?? "—"} {p.currency}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form action={addProduct}>
        <input name="name" placeholder="Name" required />
        <select name="categoryId" defaultValue="">
          <option value="">(no category)</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select name="mode" defaultValue="on_demand">
          <option value="on_demand">on_demand</option>
          <option value="stocked">stocked</option>
        </select>
        <input
          name="defaultMsrpMinor"
          placeholder="MSRP (minor units, e.g. 2999)"
          inputMode="numeric"
        />
        <input name="currency" placeholder="USD" defaultValue="USD" required />
        <textarea name="description" placeholder="Description" />
        <button type="submit">Add product (draft)</button>
      </form>
    </main>
  );
}
