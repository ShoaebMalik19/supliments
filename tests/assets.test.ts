import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { assets, auditLogs, memberships } from "@/db/schema";
import { setSessionSourceForTests } from "@/modules/auth";
import { setStorageProviderForTests, UPLOAD_POLICY } from "@/modules/assets";
import * as uploadsRoute from "@/app/api/assets/uploads/route";
import * as completeRoute from "@/app/api/assets/[id]/complete/route";
import * as urlRoute from "@/app/api/assets/[id]/url/route";
import { FakeSession } from "./fake-session";
import { bytesOf, fakeStorage, PNG_HEADER } from "./fake-storage";
import { createAsset, createTenant, createUser, pgError } from "./helpers";
import { callRoute, type Handler } from "./cross-tenant/routes";

const session = new FakeSession();
let T: Awaited<ReturnType<typeof createTenant>>;

beforeAll(async () => {
  setSessionSourceForTests(session);
  setStorageProviderForTests(fakeStorage);
  T = await createTenant();
});
afterAll(() => {
  setSessionSourceForTests(null);
  setStorageProviderForTests(null);
});
beforeEach(() => session.actAs(T.owner));

const row = async (id: string) =>
  (await privilegedDb().select().from(assets).where(eq(assets.id, id)))[0]!;

async function requestUpload(body: unknown) {
  return callRoute(uploadsRoute.POST as unknown as Handler, "POST", "http://t/", "", body);
}

async function upload(body: { kind: string; mime: string; bytes: number }, content: Uint8Array) {
  const res = await requestUpload(body);
  expect(res.status).toBe(201);
  const out = (await res.json()) as { asset: { id: string }; upload: { url: string } };
  const r = await row(out.asset.id);
  fakeStorage.put(r.bucket, r.storageKey, content);
  return { ...out, row: r };
}

const complete = (id: string) => callRoute(completeRoute.POST, "POST", "http://t/", id);
const getUrl = (id: string) => callRoute(urlRoute.GET, "GET", "http://t/", id);

describe("upload request validation", () => {
  it.each([
    ["svg", { kind: "logo", mime: "image/svg+xml", bytes: 10 }],
    ["html", { kind: "logo", mime: "text/html", bytes: 10 }],
    ["gif", { kind: "mockup", mime: "image/gif", bytes: 10 }],
    ["mime not allowed for kind", { kind: "document", mime: "image/png", bytes: 10 }],
    ["unknown kind", { kind: "avatar", mime: "image/png", bytes: 10 }],
    ["over max size", { kind: "logo", mime: "image/png", bytes: UPLOAD_POLICY.logo.maxBytes + 1 }],
    ["zero bytes", { kind: "logo", mime: "image/png", bytes: 0 }],
    ["fractional bytes", { kind: "logo", mime: "image/png", bytes: 10.5 }],
    ["client storage key", { kind: "logo", mime: "image/png", bytes: 10, storageKey: "x" }],
    ["no body", undefined],
  ])("rejects %s", async (_n, body) => {
    expect((await requestUpload(body)).status).toBe(400);
  });

  it("read_only members cannot request uploads (in-org 403)", async () => {
    const viewer = await createUser();
    await privilegedDb()
      .insert(memberships)
      .values({ orgId: T.org.id, userId: viewer.id, role: "read_only" });
    session.actAs(viewer);
    expect((await requestUpload({ kind: "logo", mime: "image/png", bytes: 10 })).status).toBe(403);
  });
});

describe("upload lifecycle", () => {
  it("pending → ready → short-lived URL; key is server-namespaced; creation audited", async () => {
    const {
      asset,
      upload: signed,
      row: r,
    } = await upload({ kind: "logo", mime: "image/png", bytes: 128 }, bytesOf(PNG_HEADER, 128));
    expect(r).toMatchObject({ uploadStatus: "pending", orgId: T.org.id, isPublic: false });
    expect(r.storageKey).toMatch(new RegExp(`^org/${T.org.id}/${asset.id}/[0-9a-f]{32}$`));
    expect(signed.url).toContain(r.storageKey);

    expect((await getUrl(asset.id)).status).toBe(404);
    const done = await complete(asset.id);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ uploadStatus: "ready" });

    const res = await getUrl(asset.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: expect.stringContaining("ttl=60"), expiresIn: 60 });

    const [audit] = await privilegedDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, asset.id), eq(auditLogs.action, "asset.upload_created")));
    expect(audit).toMatchObject({ orgId: T.org.id, actorUserId: T.owner.id });
  });

  it("completing twice is idempotent", async () => {
    const { asset } = await upload(
      { kind: "logo", mime: "image/png", bytes: 32 },
      bytesOf(PNG_HEADER, 32),
    );
    expect((await complete(asset.id)).status).toBe(200);
    expect((await complete(asset.id)).status).toBe(200);
    expect((await row(asset.id)).uploadStatus).toBe("ready");
  });

  it("complete before the object exists is 409 and stays pending", async () => {
    const res = await requestUpload({ kind: "logo", mime: "image/png", bytes: 32 });
    const { asset } = (await res.json()) as { asset: { id: string } };
    expect((await complete(asset.id)).status).toBe(409);
    expect((await row(asset.id)).uploadStatus).toBe("pending");
  });

  it.each([
    ["SVG declared as PNG", "image/png", bytesOf('<svg xmlns="http://www.w3.org/2000/svg">', 64)],
    ["HTML declared as PNG", "image/png", bytesOf("<!DOCTYPE html><script>", 64)],
    ["PNG declared as JPEG", "image/jpeg", bytesOf(PNG_HEADER, 64)],
    ["polyglot PDF", "application/pdf", bytesOf("<html>%PDF-1.7", 64)],
  ])("content mismatch (%s): object deleted, row rejected, audited", async (_n, mime, content) => {
    const { asset, row: r } = await upload({ kind: "logo", mime, bytes: 64 }, content);
    const res = await complete(asset.id);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ uploadStatus: "rejected", error: "content_mismatch" });
    expect(fakeStorage.has(r.bucket, r.storageKey)).toBe(false);
    expect((await row(asset.id)).uploadStatus).toBe("rejected");
    expect((await getUrl(asset.id)).status).toBe(404);
    const [audit] = await privilegedDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, asset.id), eq(auditLogs.action, "asset.rejected")));
    expect(audit!.after).toMatchObject({ reason: "content_mismatch", uploadStatus: "rejected" });
  });

  it("size mismatch (larger than declared) is rejected", async () => {
    const { asset, row: r } = await upload(
      { kind: "logo", mime: "image/png", bytes: 64 },
      bytesOf(PNG_HEADER, 10_000),
    );
    const res = await complete(asset.id);
    expect(await res.json()).toMatchObject({ error: "size_mismatch" });
    expect(fakeStorage.has(r.bucket, r.storageKey)).toBe(false);
  });

  it("a rejected upload cannot be revived by re-uploading and completing again", async () => {
    const { asset, row: r } = await upload(
      { kind: "logo", mime: "image/png", bytes: 64 },
      bytesOf("<svg>", 64),
    );
    await complete(asset.id);
    fakeStorage.put(r.bucket, r.storageKey, bytesOf(PNG_HEADER, 64));
    await complete(asset.id);
    expect((await row(asset.id)).uploadStatus).toBe("rejected");
  });
});

describe("download URLs", () => {
  it("platform assets are readable by any tenant once ready", async () => {
    const platform = await createAsset(null, { uploadStatus: "ready" });
    expect((await getUrl(platform.id)).status).toBe(200);
    const pending = await createAsset(null);
    expect((await getUrl(pending.id)).status).toBe(404);
  });

  it("platform assets cannot be completed (mutated) by tenants", async () => {
    const platform = await createAsset(null, { content: bytesOf(PNG_HEADER, 64) });
    expect((await complete(platform.id)).status).toBe(404);
    expect((await row(platform.id)).uploadStatus).toBe("pending");
  });
});

describe("database guards", () => {
  it("tenants cannot repoint an asset's storage key, org or bucket", async () => {
    const a = await createAsset(T.org.id, { uploadStatus: "ready" });
    for (const set of [{ storageKey: "platform/x" }, { bucket: "public" }, { isPublic: true }]) {
      await expect(
        withTenant(T.org.id, (t) => t.tx.update(assets).set(set).where(eq(assets.id, a.id))),
      ).rejects.toThrow();
    }
  });

  it("storage keys must sit under the owning org's prefix", async () => {
    const other = await createTenant();
    const msg = await pgError(
      privilegedDb()
        .insert(assets)
        .values({
          orgId: T.org.id,
          kind: "logo",
          mime: "image/png",
          bytes: 1,
          bucket: "b",
          storageKey: `org/${other.org.id}/x/y`,
        }),
    );
    expect(msg).toMatch(/assets_storage_key_scoped/);
  });
});
