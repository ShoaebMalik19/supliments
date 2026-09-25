import type { PaymentProvider } from "@/modules/billing/payment";

/** Records an ops-marked payment. No money moves; the reference is what ops saw (bank ref, etc.). */
export const manualPaymentProvider: PaymentProvider = {
  key: "manual",
  async recordPayment(input) {
    return { providerPaymentId: `manual:${input.reference}`, status: "succeeded" };
  },
};
