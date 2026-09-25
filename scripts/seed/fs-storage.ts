import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { StorageProvider } from "../../src/modules/assets";

/** Dev-only storage on local disk so the seed can render real PDFs/mockups without Supabase. */
export function fsStorage(root: string): StorageProvider {
  const base = resolve(root);
  const path = (bucket: string, key: string) => {
    const p = resolve(join(base, bucket, key));
    if (!p.startsWith(base)) throw new Error("path escapes storage root");
    return p;
  };
  return {
    async createSignedUploadUrl(bucket, key) {
      return { url: `file://${path(bucket, key)}`, token: "local" };
    },
    async readHead(bucket, key, n) {
      try {
        const data = await readFile(path(bucket, key));
        return { size: data.length, head: new Uint8Array(data.subarray(0, n)) };
      } catch {
        return null;
      }
    },
    async createSignedDownloadUrl(bucket, key) {
      return `file://${path(bucket, key)}`;
    },
    async remove(bucket, key) {
      await rm(path(bucket, key), { force: true });
    },
    async putObject(bucket, key, data) {
      const p = path(bucket, key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
    },
    async getObject(bucket, key) {
      try {
        await stat(path(bucket, key));
        return new Uint8Array(await readFile(path(bucket, key)));
      } catch {
        return null;
      }
    },
  };
}
