import { describe, expect, it } from "vitest";
import { contentMatchesMime, sniffMime } from "@/modules/assets/magic";

const b = (...parts: (ArrayLike<number> | string)[]) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "latin1")] : Array.from(p))),
  );

const PNG = b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR");
const JPEG = b([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF");
const WEBP = b("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ");
const PDF = b("%PDF-1.7\n%âãÏÓ");

describe("sniffMime", () => {
  it.each([
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["image/jpeg", b([0xff, 0xd8, 0xff, 0xdb])],
    ["image/webp", WEBP],
    ["application/pdf", PDF],
    ["application/pdf", b("%PDF-2.0")],
  ])("recognises %s", (mime, bytes) => {
    expect(sniffMime(bytes)).toBe(mime);
    expect(contentMatchesMime(bytes, mime)).toBe(true);
  });

  it("rejects a valid file declared as a different allowed type", () => {
    expect(contentMatchesMime(PNG, "image/jpeg")).toBe(false);
    expect(contentMatchesMime(JPEG, "image/png")).toBe(false);
    expect(contentMatchesMime(PDF, "image/webp")).toBe(false);
    expect(contentMatchesMime(WEBP, "application/pdf")).toBe(false);
  });

  it("never matches a mime outside the allowlist, even with valid bytes", () => {
    expect(contentMatchesMime(PNG, "image/svg+xml")).toBe(false);
    expect(contentMatchesMime(PNG, "IMAGE/PNG")).toBe(false);
  });

  it.each([
    ["empty", b()],
    ["PNG cut at 4 bytes", PNG.slice(0, 4)],
    ["PNG cut at 7 bytes", PNG.slice(0, 7)],
    ["JPEG cut at 2 bytes", JPEG.slice(0, 2)],
    ["RIFF without WEBP tag", WEBP.slice(0, 10)],
    ["%PDF- with no version", b("%PDF-")],
  ])("truncated input is unknown: %s", (_n, bytes) => {
    expect(sniffMime(bytes)).toBeNull();
  });

  it.each([
    ["SVG", b('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["SVG with XML prolog", b('<?xml version="1.0"?><svg/>')],
    ["HTML", b("<!DOCTYPE html><html><script>")],
    ["HTML with BOM", b([0xef, 0xbb, 0xbf], "<html>")],
    ["PNG signature after whitespace", b(" ", PNG)],
    ["PNG with corrupted CRLF bytes", b([0x89], "PNG\n\x1a\n")],
    ["RIFF WAVE", b("RIFF", [0, 0, 0, 0], "WAVEfmt ")],
    ["GIF", b("GIF89a")],
    ["ZIP", b("PK\x03\x04")],
  ])("disguised or disallowed content is unknown: %s", (_n, bytes) => {
    expect(sniffMime(bytes)).toBeNull();
    expect(contentMatchesMime(bytes, "image/png")).toBe(false);
  });

  it("polyglot: a PDF header after leading junk is rejected", () => {
    const polyglot = b("<html><body>", "%PDF-1.4\n");
    expect(sniffMime(polyglot)).toBeNull();
    expect(contentMatchesMime(polyglot, "application/pdf")).toBe(false);
    expect(contentMatchesMime(b([0, 0, 0, 0], PDF), "application/pdf")).toBe(false);
  });

  it("%PDF- followed by a non-version byte is rejected", () => {
    expect(sniffMime(b("%PDF-X"))).toBeNull();
  });
});
