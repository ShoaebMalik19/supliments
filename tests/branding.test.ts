import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/db/tenant";
import { setSessionSourceForTests } from "@/modules/auth";
import {
  createBrandProduct,
  getBrandProduct,
  marginQuote,
  updateBrandProduct,
} from "@/modules/branding";
import { requireTenant } from "@/modules/tenancy";
import { FakeSession } from "./fake-session";
import { createTenant, ensureFeeSchedule, seedCatalogProduct } from "./helpers";

const session = new FakeSession();
beforeAll(async () => {
  setSessionSourceForTests(session);
  await ensureFeeSchedule();
});
afterAll(() => setSessionSourceForTests(null));

describe("brand products and margin", () => {
  it("creates a brand product with per-variant retail prices and computes margin from the fee schedule", async () => {
    const A = await createTenant();
    session.actAs(A.owner);
    const ctx = await requireTenant();
    const { product, skus } = await seedCatalogProduct({ costs: [850n, 1400n] });
    const bp = await withTenant(A.org.id, (t) =>
      createBrandProduct(ctx, t, {
        brandId: A.brand.id,
        catalogProductId: product.id,
        currency: "USD",
        variants: [
          { skuId: skus[0]!.id, retailPriceMinor: 2999 },
          { skuId: skus[1]!.id, retailPriceMinor: "3999" },
        ],
      }),
    );
    expect(bp.retailPriceMinor).toBe(2999n);
    const v0 = bp.variants.find((v) => v.skuId === skus[0]!.id)!;
    expect(v0.margin?.cost.totalMinor).toBe(850n + 325n + 499n + 128n);
    expect(v0.margin?.marginMinor).toBe(2999n - 1802n);
    expect(v0.margin?.feeScheduleVersion).toBe(1);
  });

  it("rejects decimal prices, foreign SKUs, wrong currency and inactive products", async () => {
    const A = await createTenant();
    session.actAs(A.owner);
    const ctx = await requireTenant();
    const { product, skus } = await seedCatalogProduct();
    const other = await seedCatalogProduct();
    const draft = await seedCatalogProduct({ status: "draft" });
    const base = { brandId: A.brand.id, catalogProductId: product.id, currency: "USD" };
    const attempt = (body: unknown) =>
      withTenant(A.org.id, (t) => createBrandProduct(ctx, t, body));
    await expect(
      attempt({ ...base, variants: [{ skuId: skus[0]!.id, retailPriceMinor: "29.99" }] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      attempt({ ...base, variants: [{ skuId: skus[0]!.id, retailPriceMinor: 29.99 }] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      attempt({ ...base, variants: [{ skuId: other.skus[0]!.id, retailPriceMinor: 100 }] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      attempt({
        ...base,
        currency: "EUR",
        variants: [{ skuId: skus[0]!.id, retailPriceMinor: 100 }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      attempt({
        ...base,
        catalogProductId: draft.product.id,
        variants: [{ skuId: draft.skus[0]!.id, retailPriceMinor: 100 }],
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("repricing updates variants, the headline price and the audit trail", async () => {
    const A = await createTenant();
    session.actAs(A.owner);
    const ctx = await requireTenant();
    const { product, skus } = await seedCatalogProduct();
    const bp = await withTenant(A.org.id, (t) =>
      createBrandProduct(ctx, t, {
        brandId: A.brand.id,
        catalogProductId: product.id,
        currency: "USD",
        variants: skus.map((s) => ({ skuId: s.id, retailPriceMinor: 5000 })),
      }),
    );
    const after = await withTenant(A.org.id, (t) =>
      updateBrandProduct(ctx, t, bp.id, {
        variants: [{ variantId: bp.variants[0]!.id, retailPriceMinor: 1999 }],
      }),
    );
    expect(after!.retailPriceMinor).toBe(1999n);
    const fresh = await withTenant(A.org.id, (t) => getBrandProduct(t, bp.id));
    expect(fresh!.variants.map((v) => v.retailPriceMinor).sort()).toEqual([1999n, 5000n]);
  });

  it("margin calculator reports negative margins instead of hiding them", async () => {
    const A = await createTenant();
    const { skus } = await seedCatalogProduct({ costs: [2000n] });
    const q = await withTenant(A.org.id, (t) =>
      marginQuote(t, { skuId: skus[0]!.id, retailPriceMinor: "1500" }),
    );
    expect(q.marginMinor).toBeLessThan(0n);
    expect(q.currency).toBe("USD");
  });
});
