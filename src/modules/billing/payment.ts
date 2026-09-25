import { manualPaymentProvider } from "@/adapters/manual/payment";
import type { Money } from "@/lib/money";

export type RecordPaymentInput = {
  chargeId: string;
  amount: Money;
  reference: string;
  note: string | null;
  recordedBy: string;
};

export type RecordedPayment = { providerPaymentId: string; status: "succeeded" };

/**
 * How a charge gets paid. v1 has one implementation, `manual`: ops confirm money arrived outside
 * the system and the provider only records that fact (§0.1). A processor adapter replaces it later.
 */
export interface PaymentProvider {
  readonly key: string;
  recordPayment(input: RecordPaymentInput): Promise<RecordedPayment>;
}

const providers: Record<string, PaymentProvider> = { manual: manualPaymentProvider };
let override: PaymentProvider | null = null;

export function paymentProvider(key: string): PaymentProvider {
  if (override) return override;
  const p = providers[key];
  if (!p) throw new Error(`no payment provider ${key}`);
  return p;
}

export function setPaymentProviderForTests(p: PaymentProvider | null) {
  override = p;
}
