import { resendEmail } from "@/adapters/resend/email";

export type EmailMessage = { to: string; subject: string; text: string; idempotencyKey: string };

/** Transactional email as this module needs it. Providers must honour the idempotency key. */
export interface EmailProvider {
  send(message: EmailMessage): Promise<{ providerMessageId: string | null }>;
}

let override: EmailProvider | null | undefined;

/** Null when no provider is configured: notifications then stay pending, nothing is dropped. */
export function emailProvider(): EmailProvider | null {
  if (override !== undefined) return override;
  return process.env.RESEND_API_KEY && process.env.EMAIL_FROM ? resendEmail : null;
}

export function setEmailProviderForTests(p: EmailProvider | null | undefined) {
  override = p;
}
