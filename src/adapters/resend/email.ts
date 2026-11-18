import type { EmailProvider } from "@/modules/notifications/email";

let doFetch: typeof fetch = (...a) => fetch(...a);

export function setResendFetchForTests(f: typeof fetch | null) {
  doFetch = f ?? ((...a) => fetch(...a));
}

/** Resend HTTP API. Plain-text only; the Idempotency-Key makes a retried send a no-op. */
export const resendEmail: EmailProvider = {
  async send(m) {
    const key = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!key || !from) throw new Error("RESEND_API_KEY / EMAIL_FROM not set");
    const res = await doFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "idempotency-key": m.idempotencyKey,
      },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text }),
    });
    if (!res.ok) throw new Error(`resend responded ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { providerMessageId: body.id ?? null };
  },
};
