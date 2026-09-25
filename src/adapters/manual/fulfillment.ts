import type {
  CanonicalFulfillmentOrder,
  FulfillmentProvider,
  FulfillmentStatusUpdate,
  NormalizedFulfillmentStatus,
  StatusIngestResult,
} from "@/modules/fulfillment/provider";
import { parseCsv, toCsv } from "./csv";

export const EXPORT_COLUMNS = [
  "order_reference",
  "order_number",
  "brand",
  "partner_sku",
  "our_sku",
  "quantity",
  "label_version",
  "artwork_url",
  "ship_name",
  "ship_company",
  "ship_address1",
  "ship_address2",
  "ship_city",
  "ship_province",
  "ship_zip",
  "ship_country",
  "ship_phone",
  "status",
  "carrier",
  "tracking_number",
  "tracking_url",
  "shipped_at",
  "lot_number",
  "batch_code",
  "expires_on",
] as const;

const REQUIRED_IMPORT = ["order_reference", "status"] as const;

const STATUS_MAP: Record<string, NormalizedFulfillmentStatus> = {
  accepted: "accepted",
  received: "accepted",
  in_production: "in_production",
  production: "in_production",
  printing: "in_production",
  packed: "packed",
  shipped: "shipped",
  dispatched: "shipped",
  cancelled: "cancelled",
  canceled: "cancelled",
};

export function normalizePartnerStatus(raw: string): NormalizedFulfillmentStatus {
  return (
    STATUS_MAP[
      raw
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_")
    ] ?? "unknown"
  );
}

const unformula = (s: string) => (s.startsWith("'") && /^'[=+\-@]/.test(s) ? s.slice(1) : s);

/** Spreadsheet adapter: exports a CSV per dispatch batch and imports the partner's completed sheet. */
export const manualSpreadsheetProvider: FulfillmentProvider = {
  key: "manual",
  capabilities: {
    supportsCancel: false,
    supportsPartial: false,
    supportsWebhooks: false,
    transmitsByFile: true,
  },

  async submitBatch(batchId: string, orders: CanonicalFulfillmentOrder[]) {
    const rows = orders.flatMap((o) =>
      o.lines.map((l) => [
        o.reference,
        o.orderNumber,
        o.brandName,
        l.partnerSku,
        l.sku,
        l.quantity,
        l.labelVersion,
        l.artworkUrl,
        o.shipTo.name,
        o.shipTo.company,
        o.shipTo.address1,
        o.shipTo.address2,
        o.shipTo.city,
        o.shipTo.province,
        o.shipTo.zip,
        o.shipTo.countryCode,
        o.shipTo.phone,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]),
    );
    const csv = toCsv([...EXPORT_COLUMNS], rows);
    return {
      artifact: {
        filename: `dispatch-${batchId}.csv`,
        mime: "text/csv",
        data: new TextEncoder().encode(csv),
      },
      accepted: orders.map((o) => ({ reference: o.reference, externalId: null })),
    };
  },

  async ingestStatusReport(data: Uint8Array): Promise<StatusIngestResult> {
    let table: string[][];
    try {
      table = parseCsv(new TextDecoder("utf-8", { fatal: true }).decode(data));
    } catch (e) {
      return {
        updates: [],
        errors: [{ row: 0, message: `unreadable file: ${(e as Error).message}` }],
      };
    }
    const [header, ...rows] = table;
    const cols = (header ?? []).map((h) => h.trim().toLowerCase());
    const missing = REQUIRED_IMPORT.filter((c) => !cols.includes(c));
    if (missing.length)
      return {
        updates: [],
        errors: [{ row: 1, message: `missing columns: ${missing.join(", ")}` }],
      };
    const get = (r: string[], name: string) => unformula((r[cols.indexOf(name)] ?? "").trim());

    const byRef = new Map<string, FulfillmentStatusUpdate>();
    const errors: StatusIngestResult["errors"] = [];
    rows.forEach((r, i) => {
      const row = i + 2;
      const reference = get(r, "order_reference");
      const partnerStatus = get(r, "status");
      if (!reference) return errors.push({ row, message: "missing order_reference" });
      if (!partnerStatus) return errors.push({ row, message: "missing status" });
      const status = normalizePartnerStatus(partnerStatus);
      const number = get(r, "tracking_number");
      const carrier = get(r, "carrier");
      if (status === "shipped" && (!number || !carrier))
        return errors.push({ row, message: "shipped rows need carrier and tracking_number" });
      const shippedRaw = get(r, "shipped_at");
      const shippedAt = shippedRaw ? new Date(shippedRaw) : null;
      if (shippedAt && Number.isNaN(shippedAt.getTime()))
        return errors.push({ row, message: `invalid shipped_at: ${shippedRaw}` });
      const expires = get(r, "expires_on");
      if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires))
        return errors.push({ row, message: `invalid expires_on: ${expires}` });
      const update: FulfillmentStatusUpdate = {
        reference,
        status,
        partnerStatus,
        tracking:
          number && carrier ? { number, carrier, url: get(r, "tracking_url") || null } : null,
        shippedAt,
        lotNumber: get(r, "lot_number") || null,
        batchCode: get(r, "batch_code") || null,
        expiresOn: expires || null,
        row,
      };
      const prev = byRef.get(reference);
      if (
        prev &&
        (prev.status !== update.status || prev.tracking?.number !== update.tracking?.number)
      )
        return errors.push({
          row,
          message: `conflicting rows for ${reference} (see row ${prev.row})`,
        });
      if (!prev) byRef.set(reference, update);
    });
    return { updates: [...byRef.values()], errors };
  },
};
