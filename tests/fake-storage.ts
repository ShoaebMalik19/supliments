import type { StorageProvider } from "@/modules/assets";

export const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function bytesOf(prefix: number[] | string, total: number) {
  const head = typeof prefix === "string" ? Buffer.from(prefix, "latin1") : Uint8Array.from(prefix);
  const out = new Uint8Array(total);
  out.set(head.subarray(0, total));
  return out;
}

export class FakeStorage implements StorageProvider {
  objects = new Map<string, Uint8Array>();
  removed: string[] = [];

  put(bucket: string, key: string, data: Uint8Array) {
    this.objects.set(`${bucket}/${key}`, data);
  }

  has(bucket: string, key: string) {
    return this.objects.has(`${bucket}/${key}`);
  }

  async createSignedUploadUrl(bucket: string, key: string) {
    return { url: `https://storage.test/upload/${bucket}/${key}?sig=x`, token: "tok" };
  }

  async readHead(bucket: string, key: string, nBytes: number) {
    const data = this.objects.get(`${bucket}/${key}`);
    return data ? { size: data.length, head: data.slice(0, nBytes) } : null;
  }

  async createSignedDownloadUrl(bucket: string, key: string, ttl: number) {
    return `https://storage.test/download/${bucket}/${key}?ttl=${ttl}`;
  }

  async putObject(bucket: string, key: string, data: Uint8Array) {
    this.put(bucket, key, data);
  }

  async getObject(bucket: string, key: string) {
    return this.objects.get(`${bucket}/${key}`) ?? null;
  }

  async remove(bucket: string, key: string) {
    this.objects.delete(`${bucket}/${key}`);
    this.removed.push(`${bucket}/${key}`);
  }
}

export const fakeStorage = new FakeStorage();
