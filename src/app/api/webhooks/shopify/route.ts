import { receiveShopifyWebhook } from "@/modules/integrations";

export const dynamic = "force-dynamic";

/** Pre-tenant by design: authenticated by HMAC, routed only to the org that owns the shop. */
export const POST = (req: Request) => receiveShopifyWebhook(req);
