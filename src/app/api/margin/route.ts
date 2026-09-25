import { marginQuote } from "@/modules/branding";
import { tenantRoute } from "@/modules/tenancy";

export const GET = tenantRoute("org:read", async (_ctx, t, req) =>
  marginQuote(t, Object.fromEntries(new URL(req.url).searchParams)),
);
