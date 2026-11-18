import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const LEGAL_DOCS = { terms: "Terms of Service", privacy: "Privacy Policy" } as const;
export type LegalDoc = keyof typeof LEGAL_DOCS;

export type LegalBlock = { kind: "heading" | "paragraph"; text: string };

/** Counsel-supplied text from content/legal/{doc}.md; null until it exists. */
export async function loadLegalDoc(doc: LegalDoc): Promise<LegalBlock[] | null> {
  let raw: string;
  try {
    raw = await readFile(join(process.cwd(), "content/legal", `${doc}.md`), "utf8");
  } catch {
    return null;
  }
  const blocks = raw
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b): LegalBlock =>
      b.startsWith("# ")
        ? { kind: "heading", text: b.slice(2).trim() }
        : { kind: "paragraph", text: b.replace(/\s*\n\s*/g, " ") },
    );
  return blocks.length ? blocks : null;
}
