import { manualSpreadsheetProvider } from "@/adapters/manual/fulfillment";
import type { FulfillmentProvider } from "./provider";

const providers: Record<string, FulfillmentProvider> = { manual: manualSpreadsheetProvider };

export function fulfillmentProvider(adapterKey: string): FulfillmentProvider {
  const p = providers[adapterKey];
  if (!p) throw new Error(`no fulfillment adapter registered for "${adapterKey}"`);
  return p;
}
