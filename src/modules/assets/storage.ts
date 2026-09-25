import { supabaseStorage } from "@/adapters/supabase/storage";

export type ObjectHead = { size: number; head: Uint8Array };

/** Object storage as the assets module needs it. Buckets are private; access is by signed URL. */
export interface StorageProvider {
  createSignedUploadUrl(bucket: string, key: string): Promise<{ url: string; token: string }>;
  /** First `nBytes` of the object plus its total size, or null when the object does not exist. */
  readHead(bucket: string, key: string, nBytes: number): Promise<ObjectHead | null>;
  createSignedDownloadUrl(bucket: string, key: string, ttlSeconds: number): Promise<string>;
  remove(bucket: string, key: string): Promise<void>;
}

let override: StorageProvider | null = null;

export const storage = (): StorageProvider => override ?? supabaseStorage;

export function setStorageProviderForTests(p: StorageProvider | null) {
  override = p;
}
