import { downloadUrl } from "@/modules/assets";
import { tenantRoute } from "@/modules/tenancy";

/** JSON `{url, expiresIn}`; with `?redirect=1` a 302 to it (links in emails). */
export const GET = tenantRoute<{ id: string }>("org:read", async (_ctx, t, req, { id }) => {
  const found = await downloadUrl(t, id);
  if (!found || new URL(req.url).searchParams.get("redirect") !== "1") return found;
  return new Response(null, {
    status: 302,
    headers: { location: found.url, "cache-control": "no-store" },
  });
});
