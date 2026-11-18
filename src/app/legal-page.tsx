import { LEGAL_DOCS, loadLegalDoc, type LegalDoc } from "@/lib/legal";

export async function LegalPage({ doc }: { doc: LegalDoc }) {
  const blocks = await loadLegalDoc(doc);
  return (
    <main>
      <h1>{LEGAL_DOCS[doc]}</h1>
      {blocks ? (
        blocks.map((b, i) =>
          b.kind === "heading" ? <h2 key={i}>{b.text}</h2> : <p key={i}>{b.text}</p>,
        )
      ) : (
        <p>This document is being finalised. Contact us for the current version.</p>
      )}
    </main>
  );
}
