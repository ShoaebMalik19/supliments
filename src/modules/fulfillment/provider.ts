export type ShipTo = {
  name: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  countryCode: string | null;
  phone: string | null;
};

/** Partner-agnostic order handed to any FulfillmentProvider (§11). */
export type CanonicalFulfillmentOrder = {
  /** Our idempotency key, recorded before anything leaves the system; the partner echoes it back. */
  reference: string;
  orderNumber: string | null;
  brandName: string;
  shipTo: ShipTo;
  lines: {
    sku: string;
    partnerSku: string;
    quantity: number;
    artworkUrl: string | null;
    labelVersion: number | null;
  }[];
};

export type NormalizedFulfillmentStatus =
  "accepted" | "in_production" | "packed" | "shipped" | "cancelled" | "unknown";

export type FulfillmentStatusUpdate = {
  reference: string;
  status: NormalizedFulfillmentStatus;
  partnerStatus: string;
  tracking: { number: string; carrier: string; url: string | null } | null;
  shippedAt: Date | null;
  lotNumber: string | null;
  batchCode: string | null;
  expiresOn: string | null;
  row: number;
};

export type SubmitBatchResult = {
  /** A file to hand to the partner, when the adapter transmits by file. */
  artifact: { filename: string; mime: string; data: Uint8Array } | null;
  accepted: { reference: string; externalId: string | null }[];
};

export type StatusIngestResult = {
  updates: FulfillmentStatusUpdate[];
  errors: { row: number; message: string }[];
};

export interface FulfillmentProvider {
  readonly key: string;
  readonly capabilities: {
    supportsCancel: boolean;
    supportsPartial: boolean;
    supportsWebhooks: boolean;
    transmitsByFile: boolean;
  };
  submitBatch(batchId: string, orders: CanonicalFulfillmentOrder[]): Promise<SubmitBatchResult>;
  /** Parses a partner status report (file upload or webhook body) into normalized updates. */
  ingestStatusReport(data: Uint8Array): Promise<StatusIngestResult>;
}
