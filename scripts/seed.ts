import { eq } from "drizzle-orm";
import sharp from "sharp";
import { closeDb } from "../src/db/client";
import { privilegedDb } from "../src/db/privileged";
import { withTenant } from "../src/db/tenant";
import { brands, integrations, organizations, platformAdmins, users } from "../src/db/schema";
import { setStorageProviderForTests, storeGeneratedAsset } from "../src/modules/assets";
import { createBrandProduct } from "../src/modules/branding";
import {
  approveSubmittedLabel,
  createLabelDraft,
  submitLabel,
  updateLabelDesign,
} from "../src/modules/labels";
import { ingestExternalOrder } from "../src/modules/orders";
import { provisionOrganization } from "../src/modules/tenancy";
import { fsStorage } from "./seed/fs-storage";
import { DEMO_SKUS, seedPlatform } from "./seed/platform";
import { DEMO_ADMIN_EMAIL, DEMO_OWNER_EMAIL, demoUsers } from "./seed/users";

const DEMO_ORG = "Demo Supplements Co.";
const STORAGE_ROOT = process.env.SEED_STORAGE_DIR ?? ".data/storage";

setStorageProviderForTests(fsStorage(STORAGE_ROOT));
const platform = await seedPlatform();
console.log(
  `platform: product ${platform.product.id}, fulfillment center ${platform.fulfillmentCenter.id}`,
);

const db = privilegedDb();
const [existing] = await db.select().from(organizations).where(eq(organizations.name, DEMO_ORG));
if (existing) {
  console.log(`demo org exists (${existing.id}); nothing else to do`);
} else {
  const accounts = demoUsers();
  const ownerId = await accounts.resolve(DEMO_OWNER_EMAIL);
  const org = await provisionOrganization({
    userId: ownerId,
    email: DEMO_OWNER_EMAIL,
    orgName: DEMO_ORG,
  });
  const adminId = await accounts.resolve(DEMO_ADMIN_EMAIL);
  await db.insert(users).values({ id: adminId, email: DEMO_ADMIN_EMAIL }).onConflictDoNothing();
  await db.insert(platformAdmins).values({ userId: adminId }).onConflictDoNothing();
  console.log(
    accounts.mode === "supabase"
      ? `demo sign-ins: ${DEMO_OWNER_EMAIL} (brand owner), ${DEMO_ADMIN_EMAIL} (platform admin); password = SEED_DEMO_PASSWORD`
      : "Supabase not configured: demo users are local-only and cannot sign in",
  );
  const ctx = { userId: ownerId, email: DEMO_OWNER_EMAIL, orgId: org.id, role: "owner" as const };

  const labelId = await withTenant(org.id, async (t) => {
    const [brand] = await t.tx.select().from(brands);
    const bp = await createBrandProduct(ctx, t, {
      brandId: brand!.id,
      catalogProductId: platform.product.id,
      currency: "USD",
      variants: platform.skus.map((s, i) => ({ skuId: s.id, retailPriceMinor: 2999 + i * 200 })),
    });
    const logoPng = await sharp({
      create: { width: 600, height: 600, channels: 4, background: "#1f6feb" },
    })
      .png()
      .toBuffer();
    const logo = await storeGeneratedAsset(t, {
      kind: "logo",
      mime: "image/png",
      data: new Uint8Array(logoPng),
      width: 600,
      height: 600,
    });
    const draft = await createLabelDraft(ctx, t, bp.id, {});
    await updateLabelDesign(ctx, t, draft!.id, {
      designState: {
        brandName: "Demo Labs",
        variantName: "Unflavored",
        logo: logo.id,
        backgroundColor: "#ffffff",
        textColor: "#111111",
      },
    });
    await submitLabel(ctx, t, draft!.id);
    return { labelId: draft!.id, brandId: brand!.id };
  });
  await withTenant(org.id, (t) => approveSubmittedLabel({ userId: adminId }, t, labelId.labelId));

  const [integration] = await db
    .insert(integrations)
    .values({
      orgId: org.id,
      brandId: labelId.brandId,
      provider: "manual",
      externalShopId: `demo-${org.id}`,
      status: "connected",
    })
    .returning();
  const result = await ingestExternalOrder(
    { orgId: org.id, integrationId: integration!.id },
    {
      externalOrderId: "DEMO-1001",
      externalOrderNumber: "#1001",
      currency: "USD",
      placedAt: new Date(),
      financialStatus: "paid",
      cancelled: false,
      test: false,
      customer: { externalId: null, email: "buyer@demo.local", name: "Ada Buyer", phone: null },
      shipTo: {
        name: "Ada Buyer",
        address1: "1 Main St",
        city: "Austin",
        province: "TX",
        zip: "78701",
        countryCode: "US",
      },
      billTo: null,
      subtotalMinor: 5998n,
      shippingMinor: 499n,
      totalMinor: 6497n,
      lines: [
        {
          externalLineItemId: "L1",
          externalVariantId: null,
          sku: DEMO_SKUS[0]!.sku,
          title: "Creatine",
          quantity: 2,
          unitPriceMinor: 2999n,
        },
      ],
    },
  );
  console.log(
    `demo org ${org.id}: label approved (${labelId.labelId}), sample order ${JSON.stringify(result)}`,
  );
  console.log(`rendered files are under ${STORAGE_ROOT}/`);
}
await closeDb();
