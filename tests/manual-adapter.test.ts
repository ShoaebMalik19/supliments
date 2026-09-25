import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "@/adapters/manual/csv";
import {
  EXPORT_COLUMNS,
  manualSpreadsheetProvider as p,
  normalizePartnerStatus,
} from "@/adapters/manual/fulfillment";
import type { CanonicalFulfillmentOrder } from "@/modules/fulfillment/provider";

const order: CanonicalFulfillmentOrder = {
  reference: "fo:abc",
  orderNumber: "#1001",
  brandName: 'Acme "Pure", Inc',
  shipTo: {
    name: '=HYPERLINK("x")',
    company: null,
    address1: "1 Main St\nApt 2",
    address2: null,
    city: "Austin",
    province: "TX",
    zip: "78701",
    countryCode: "US",
    phone: "+15125550100",
  },
  lines: [
    {
      sku: "CRE-60",
      partnerSku: "P-900",
      quantity: 2,
      artworkUrl: "https://x/y.pdf",
      labelVersion: 3,
    },
  ],
};

const enc = (s: string) => new TextEncoder().encode(s);

describe("CSV", () => {
  it("round-trips quotes, commas and newlines", () => {
    const csv = toCsv(["a", "b"], [['he said "hi", ok', "line1\r\nline2"]]);
    expect(parseCsv(csv)).toEqual([
      ["a", "b"],
      ['he said "hi", ok', "line1\r\nline2"],
    ]);
  });

  it("neutralises spreadsheet formula injection", () => {
    expect(toCsv(["a"], [["=1+1"], ["+cmd"], ["-2"], ["@x"]])).toBe(
      "a\r\n'=1+1\r\n'+cmd\r\n'-2\r\n'@x\r\n",
    );
  });

  it("rejects unterminated quotes", () => {
    expect(() => parseCsv('a,"b\n')).toThrow();
  });
});

describe("spreadsheet fulfillment adapter", () => {
  it("exports one row per line with the canonical reference", async () => {
    const { artifact, accepted } = await p.submitBatch("batch-1", [order]);
    const rows = parseCsv(new TextDecoder().decode(artifact!.data));
    expect(rows[0]).toEqual([...EXPORT_COLUMNS]);
    const row = Object.fromEntries(EXPORT_COLUMNS.map((c, i) => [c, rows[1]![i]]));
    expect(row).toMatchObject({
      order_reference: "fo:abc",
      partner_sku: "P-900",
      quantity: "2",
      ship_address1: "1 Main St\nApt 2",
      brand: 'Acme "Pure", Inc',
    });
    expect(row.ship_name).toBe('\'=HYPERLINK("x")');
    expect(accepted).toEqual([{ reference: "fo:abc", externalId: null }]);
  });

  it("imports the completed sheet (the exported file with status columns filled)", async () => {
    const { artifact } = await p.submitBatch("b", [order]);
    const rows = parseCsv(new TextDecoder().decode(artifact!.data));
    const idx = (c: string) => EXPORT_COLUMNS.indexOf(c as (typeof EXPORT_COLUMNS)[number]);
    const filled = rows[1]!.slice();
    filled[idx("status")] = "Shipped";
    filled[idx("carrier")] = "UPS";
    filled[idx("tracking_number")] = "1Z999";
    filled[idx("shipped_at")] = "2026-09-20T10:00:00Z";
    filled[idx("lot_number")] = "LOT-7";
    filled[idx("expires_on")] = "2028-09-01";
    const res = await p.ingestStatusReport(enc(toCsv(rows[0]!, [filled])));
    expect(res.errors).toEqual([]);
    expect(res.updates[0]).toMatchObject({
      reference: "fo:abc",
      status: "shipped",
      tracking: { number: "1Z999", carrier: "UPS" },
      lotNumber: "LOT-7",
      expiresOn: "2028-09-01",
    });
  });

  it("reports malformed rows without dropping good ones", async () => {
    const csv =
      "order_reference,status,carrier,tracking_number,shipped_at\r\nfo:1,shipped,UPS,1Z1,\r\n,shipped,UPS,1Z2,\r\nfo:3,shipped,,,\r\nfo:4,shipped,UPS,1Z4,notadate\r\nfo:5,teleported,,,\r\n";
    const res = await p.ingestStatusReport(enc(csv));
    expect(res.updates.map((u) => [u.reference, u.status])).toEqual([
      ["fo:1", "shipped"],
      ["fo:5", "unknown"],
    ]);
    expect(res.errors.map((e) => e.row)).toEqual([3, 4, 5]);
  });

  it("flags conflicting duplicate rows, tolerates identical ones", async () => {
    const csv =
      "order_reference,status,carrier,tracking_number\nfo:1,shipped,UPS,1Z1\nfo:1,shipped,UPS,1Z1\nfo:1,shipped,UPS,1Z9\n";
    const res = await p.ingestStatusReport(enc(csv));
    expect(res.updates).toHaveLength(1);
    expect(res.errors).toEqual([{ row: 4, message: expect.stringContaining("conflicting") }]);
  });

  it("rejects files missing required columns or not UTF-8", async () => {
    expect((await p.ingestStatusReport(enc("foo,bar\n1,2\n"))).errors[0]!.message).toMatch(
      /missing columns/,
    );
    expect(
      (await p.ingestStatusReport(new Uint8Array([0xff, 0xfe, 0x00]))).errors[0]!.message,
    ).toMatch(/unreadable/);
  });

  it("normalizes partner statuses with an explicit unknown bucket", () => {
    expect(normalizePartnerStatus("In Production")).toBe("in_production");
    expect(normalizePartnerStatus("DISPATCHED")).toBe("shipped");
    expect(normalizePartnerStatus("lost in space")).toBe("unknown");
  });
});
