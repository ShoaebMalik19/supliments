import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as health from "@/app/api/health/route";
import { loadLegalDoc } from "@/lib/legal";

afterEach(() => vi.restoreAllMocks());

describe("GET /api/health", () => {
  it("answers 200 {ok:true} with the database up and reveals nothing else", async () => {
    const res = await health.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, commit: null });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("legal documents", () => {
  it("are absent until counsel's text is added, then parse into headings and paragraphs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "legal-"));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    expect(await loadLegalDoc("terms")).toBeNull();
    await mkdir(join(dir, "content/legal"), { recursive: true });
    await writeFile(join(dir, "content/legal/terms.md"), "# One\n\nFirst line\nwraps.\n\nSecond.");
    expect(await loadLegalDoc("terms")).toEqual([
      { kind: "heading", text: "One" },
      { kind: "paragraph", text: "First line wraps." },
      { kind: "paragraph", text: "Second." },
    ]);
  });
});
