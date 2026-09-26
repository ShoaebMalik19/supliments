import type { StorageProvider } from "@/modules/assets/storage";
import { serviceClient } from "./service";

async function readPrefix(body: ReadableStream<Uint8Array>, n: number) {
  const reader = body.getReader();
  const out = new Uint8Array(n);
  let len = 0;
  while (len < n) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = value.subarray(0, n - len);
    out.set(take, len);
    len += take.length;
  }
  await reader.cancel();
  return out.subarray(0, len);
}

export const supabaseStorage: StorageProvider = {
  async createSignedUploadUrl(bucket, key) {
    const { data, error } = await serviceClient().storage.from(bucket).createSignedUploadUrl(key);
    if (error) throw error;
    return { url: data.signedUrl, token: data.token };
  },

  async readHead(bucket, key, nBytes) {
    const files = serviceClient().storage.from(bucket);
    const info = await files.info(key);
    if (info.error) {
      if (info.error.status === 400 || info.error.status === 404) return null;
      throw info.error;
    }
    const signed = await files.createSignedUrl(key, 30);
    if (signed.error) throw signed.error;
    const res = await fetch(signed.data.signedUrl, {
      headers: { range: `bytes=0-${nBytes - 1}` },
    });
    if (!res.ok || !res.body) throw new Error(`storage read failed: ${res.status}`);
    const total = info.data.size ?? Number(res.headers.get("content-range")?.split("/")[1]);
    if (!Number.isSafeInteger(total)) throw new Error("storage did not report object size");
    return { size: total, head: await readPrefix(res.body, nBytes) };
  },

  async createSignedDownloadUrl(bucket, key, ttlSeconds) {
    const { data, error } = await serviceClient()
      .storage.from(bucket)
      .createSignedUrl(key, ttlSeconds);
    if (error) throw error;
    return data.signedUrl;
  },

  async remove(bucket, key) {
    const { error } = await serviceClient().storage.from(bucket).remove([key]);
    if (error) throw error;
  },

  async putObject(bucket, key, data, contentType) {
    const { error } = await serviceClient()
      .storage.from(bucket)
      .upload(key, data, { contentType, upsert: false });
    if (error) throw error;
  },

  async getObject(bucket, key) {
    const { data, error } = await serviceClient().storage.from(bucket).download(key);
    if (error) {
      if (
        (error as { status?: number }).status === 400 ||
        (error as { status?: number }).status === 404
      )
        return null;
      throw error;
    }
    return new Uint8Array(await data.arrayBuffer());
  },
};
