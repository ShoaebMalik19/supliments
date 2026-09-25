import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantDb } from "@/db/tenant";
import { assets } from "@/db/schema";
import { assetKind } from "@/db/schema/enums";
import { recordAudit } from "@/modules/audit";
import type { TenantContext } from "@/modules/tenancy";
import { badRequest, HttpError, json } from "@/lib/http";
import { contentMatchesMime, sniffMime, SNIFF_BYTES, type AllowedMime } from "./magic";
import { storage } from "./storage";

export { setStorageProviderForTests, type StorageProvider, type ObjectHead } from "./storage";
export { sniffMime, contentMatchesMime, ALLOWED_MIMES, SNIFF_BYTES } from "./magic";

export type AssetKind = (typeof assetKind.enumValues)[number];

const MB = 1024 * 1024;
const IMAGES: AllowedMime[] = ["image/png", "image/jpeg", "image/webp"];

export const UPLOAD_POLICY: Record<AssetKind, { mimes: AllowedMime[]; maxBytes: number }> = {
  logo: { mimes: [...IMAGES, "application/pdf"], maxBytes: 5 * MB },
  label_print: { mimes: ["application/pdf", "image/png"], maxBytes: 50 * MB },
  label_preview: { mimes: IMAGES, maxBytes: 10 * MB },
  mockup: { mimes: IMAGES, maxBytes: 10 * MB },
  product_image: { mimes: IMAGES, maxBytes: 10 * MB },
  document: { mimes: ["application/pdf"], maxBytes: 20 * MB },
};

export const DOWNLOAD_TTL_SECONDS = 60;

export const assetsBucket = () => process.env.ASSETS_BUCKET ?? "assets-private";

const uploadInput = z
  .strictObject({
    kind: z.enum(assetKind.enumValues),
    mime: z.string(),
    bytes: z.int().positive(),
  })
  .superRefine((v, ctx) => {
    const policy = UPLOAD_POLICY[v.kind];
    if (!(policy.mimes as string[]).includes(v.mime))
      ctx.addIssue({ code: "custom", path: ["mime"], message: `not allowed for ${v.kind}` });
    if (v.bytes > policy.maxBytes)
      ctx.addIssue({ code: "custom", path: ["bytes"], message: `max ${policy.maxBytes}` });
  });

const isUuid = (id: string) => z.uuid().safeParse(id).success;

type Asset = typeof assets.$inferSelect;

const view = (a: Asset) => ({
  id: a.id,
  kind: a.kind,
  mime: a.mime,
  bytes: a.bytes,
  uploadStatus: a.uploadStatus,
  createdAt: a.createdAt,
});

/** Storage keys are always server-generated: `org/{orgId}/{assetId}/{random}`. */
export const storageKeyFor = (orgId: string, assetId: string) =>
  `org/${orgId}/${assetId}/${randomBytes(16).toString("hex")}`;

export async function createUpload(ctx: TenantContext, t: TenantDb, raw: unknown) {
  const parsed = uploadInput.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  const { kind, mime, bytes } = parsed.data;
  const [{ id }] = (await t.tx.execute(sql`select uuid_generate_v7()::text as id`)) as unknown as [
    { id: string },
  ];
  const bucket = assetsBucket();
  const asset = await t.insert(assets, {
    id,
    kind,
    mime,
    bytes,
    bucket,
    storageKey: storageKeyFor(t.orgId, id),
    uploadedBy: ctx.userId,
  });
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "asset.upload_created",
      entityType: "asset",
      entityId: id,
      after: view(asset),
    },
    t.tx,
  );
  const upload = await storage().createSignedUploadUrl(bucket, asset.storageKey);
  return json({ asset: view(asset), upload }, { status: 201 });
}

/**
 * Verifies the uploaded object against what was declared (magic bytes + exact size).
 * On mismatch the object is deleted and the asset is marked `rejected` (terminal).
 */
export async function completeUpload(ctx: TenantContext, t: TenantDb, id: string) {
  if (!isUuid(id)) return null;
  const [asset] = await t.tx
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.orgId, t.orgId)))
    .for("update");
  if (!asset) return null;
  if (asset.uploadStatus !== "pending") return view(asset);

  const object = await storage().readHead(asset.bucket, asset.storageKey, SNIFF_BYTES);
  if (!object) throw new HttpError(409, "Upload not received yet");

  const reason =
    object.size !== asset.bytes
      ? "size_mismatch"
      : !contentMatchesMime(object.head, asset.mime)
        ? "content_mismatch"
        : null;

  if (!reason) return view((await t.update(assets, id, { uploadStatus: "ready" }))!);

  await storage().remove(asset.bucket, asset.storageKey);
  const rejected = (await t.update(assets, id, { uploadStatus: "rejected" }))!;
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "asset.rejected",
      entityType: "asset",
      entityId: id,
      before: view(asset),
      after: {
        ...view(rejected),
        reason,
        actualBytes: object.size,
        detectedMime: sniffMime(object.head),
      },
    },
    t.tx,
  );
  return json({ ...view(rejected), error: reason }, { status: 422 });
}

/** Short-lived download URL for a ready asset of the caller's org, or a platform asset. */
export async function downloadUrl(t: TenantDb, id: string) {
  if (!isUuid(id)) return null;
  const [asset] = await t.tx
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.id, id),
        eq(assets.uploadStatus, "ready"),
        or(eq(assets.orgId, t.orgId), isNull(assets.orgId)),
      ),
    );
  if (!asset) return null;
  const url = await storage().createSignedDownloadUrl(
    asset.bucket,
    asset.storageKey,
    DOWNLOAD_TTL_SECONDS,
  );
  return { url, expiresIn: DOWNLOAD_TTL_SECONDS };
}

/** Server-generated asset (render output): bytes are ours, so it is `ready` on creation. */
export async function storeGeneratedAsset(
  t: TenantDb,
  input: { kind: AssetKind; mime: AllowedMime; data: Uint8Array; width?: number; height?: number },
) {
  const [{ id }] = (await t.tx.execute(sql`select uuid_generate_v7()::text as id`)) as unknown as [
    { id: string },
  ];
  const bucket = assetsBucket();
  const storageKey = storageKeyFor(t.orgId, id);
  await storage().putObject(bucket, storageKey, input.data, input.mime);
  return t.insert(assets, {
    id,
    kind: input.kind,
    mime: input.mime,
    bytes: input.data.length,
    width: input.width,
    height: input.height,
    bucket,
    storageKey,
    checksum: createHash("sha256").update(input.data).digest("hex"),
    uploadStatus: "ready",
  });
}

/** Bytes of a ready asset visible to the tenant (own org or platform), or null. */
export async function readAssetBytes(t: TenantDb, id: string) {
  if (!isUuid(id)) return null;
  const [asset] = await t.tx
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.id, id),
        eq(assets.uploadStatus, "ready"),
        or(eq(assets.orgId, t.orgId), isNull(assets.orgId)),
      ),
    );
  if (!asset) return null;
  const data = await storage().getObject(asset.bucket, asset.storageKey);
  return data ? { asset, data } : null;
}
