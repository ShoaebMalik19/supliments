import type { ExternalOrder, IngestResult, IngestTarget } from "./external";

export * from "./external";
export * from "./state";

/** Idempotent on (integration, externalOrderId). Implemented in Milestone 4. */
export async function ingestExternalOrder(
  _target: IngestTarget,
  _order: ExternalOrder,
): Promise<IngestResult> {
  throw new Error("ingestExternalOrder not implemented");
}
