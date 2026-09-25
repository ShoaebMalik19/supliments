import type { TenantDb } from "@/db/tenant";
import { brandVariantsById, brandVariantsBySku, latestApprovedLabels } from "@/modules/branding";
import { skusByCode, skuUnitCostsAt } from "@/modules/catalog";
import { mappedVariants } from "@/modules/integrations/orders";
import type { Money } from "@/lib/money";
import type { ExternalOrder } from "./external";

export type ExternalLine = ExternalOrder["lines"][number];

export type UnresolvedReason =
  | "mapped_variant_unavailable"
  | "sku_not_offered_by_brand"
  | "ambiguous_sku"
  | "no_approved_label"
  | "currency_mismatch";

export type ResolvedLine = {
  line: ExternalLine;
  variantId: string;
  skuId: string;
  labelId: string;
  unitCost: Money;
};

export type UnresolvedLine = {
  line: ExternalLine;
  reason: UnresolvedReason;
  variantId: string | null;
  skuId: string | null;
};

export type LineResolution = {
  resolved: ResolvedLine[];
  unresolved: UnresolvedLine[];
  /** Lines that are not our catalog at all (brands sell other goods); never an error. */
  skipped: ExternalLine[];
};

/**
 * §9.5 line resolution. Order of precedence: the integration's product_sync_mapping for the
 * external variant, then the SKU code among the brand's active variants. Titles are never used.
 * A line carrying one of our SKU codes that this brand does not (actively) sell is unresolved;
 * a line matching nothing of ours is skipped.
 */
export async function resolveLines(
  t: TenantDb,
  input: {
    integrationId: string;
    brandId: string;
    currency: string;
    at: Date;
    lines: ExternalLine[];
  },
): Promise<LineResolution> {
  const { brandId, lines } = input;
  const variantIds = lines.flatMap((l) => (l.externalVariantId ? [l.externalVariantId] : []));
  const codes = [...new Set(lines.flatMap((l) => (l.sku ? [l.sku] : [])))];
  const mapped = await mappedVariants(t, input.integrationId, variantIds);
  const byId = new Map(
    (await brandVariantsById(t, brandId, [...new Set(mapped.values())])).map((v) => [
      v.variantId,
      v,
    ]),
  );
  const bySku = new Map<string, Awaited<ReturnType<typeof brandVariantsBySku>>>();
  for (const v of await brandVariantsBySku(t, brandId, codes))
    bySku.set(v.sku, [...(bySku.get(v.sku) ?? []), v]);
  const ours = new Map((await skusByCode(t, codes)).map((s) => [s.sku, s.id]));

  const out: LineResolution = { resolved: [], unresolved: [], skipped: [] };
  const candidates: { line: ExternalLine; variantId: string; skuId: string; bp: string }[] = [];
  for (const line of lines) {
    const mappedId = line.externalVariantId ? mapped.get(line.externalVariantId) : undefined;
    if (mappedId) {
      const v = byId.get(mappedId);
      if (v)
        candidates.push({ line, variantId: v.variantId, skuId: v.skuId, bp: v.brandProductId });
      else
        out.unresolved.push({
          line,
          reason: "mapped_variant_unavailable",
          variantId: mappedId,
          skuId: null,
        });
      continue;
    }
    const matches = line.sku ? (bySku.get(line.sku) ?? []) : [];
    if (matches.length === 1) {
      const v = matches[0]!;
      candidates.push({ line, variantId: v.variantId, skuId: v.skuId, bp: v.brandProductId });
    } else if (matches.length > 1) {
      out.unresolved.push({
        line,
        reason: "ambiguous_sku",
        variantId: null,
        skuId: matches[0]!.skuId,
      });
    } else if (line.sku && ours.has(line.sku)) {
      out.unresolved.push({
        line,
        reason: "sku_not_offered_by_brand",
        variantId: null,
        skuId: ours.get(line.sku)!,
      });
    } else {
      out.skipped.push(line);
    }
  }

  const labels = await latestApprovedLabels(t, [...new Set(candidates.map((c) => c.bp))]);
  const costs = await skuUnitCostsAt(t, [...new Set(candidates.map((c) => c.skuId))], input.at);
  for (const c of candidates) {
    const labelId = labels.get(c.bp);
    const unitCost = costs.get(c.skuId)!;
    const fail = (reason: UnresolvedReason) =>
      out.unresolved.push({ line: c.line, reason, variantId: c.variantId, skuId: c.skuId });
    if (!labelId) fail("no_approved_label");
    else if (unitCost.currency !== input.currency) fail("currency_mismatch");
    else
      out.resolved.push({
        line: c.line,
        variantId: c.variantId,
        skuId: c.skuId,
        labelId,
        unitCost,
      });
  }
  return out;
}
