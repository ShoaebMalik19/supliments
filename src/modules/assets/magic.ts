export const ALLOWED_MIMES = ["image/png", "image/jpeg", "image/webp", "application/pdf"] as const;
export type AllowedMime = (typeof ALLOWED_MIMES)[number];

/** Bytes needed from the start of an object to identify every allowed type. */
export const SNIFF_BYTES = 16;

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

const startsWith = (b: Uint8Array, sig: number[], offset = 0) =>
  b.length >= offset + sig.length && sig.every((x, i) => b[offset + i] === x);

const SIGNATURES: Record<AllowedMime, (b: Uint8Array) => boolean> = {
  "image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  "image/webp": (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
  // Offset 0 only: readers tolerate a header after leading junk, which enables polyglots.
  "application/pdf": (b) =>
    startsWith(b, ascii("%PDF-")) && b[5] !== undefined && b[5] >= 0x31 && b[5] <= 0x32,
};

/** Identifies an allowed type from leading bytes; anything else (SVG, HTML, truncated) is null. */
export function sniffMime(head: Uint8Array): AllowedMime | null {
  return ALLOWED_MIMES.find((m) => SIGNATURES[m](head)) ?? null;
}

export function contentMatchesMime(head: Uint8Array, declared: string): boolean {
  return sniffMime(head) === declared;
}
