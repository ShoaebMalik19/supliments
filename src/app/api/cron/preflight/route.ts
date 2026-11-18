import { preflight } from "@/modules/admin/preflight";
import { cronAuthorized } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Go-live self-check of the deployed app. Same bearer secret as the cron route; 404 otherwise. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Not found", { status: 404 });
  return Response.json(await preflight({ origin: new URL(req.url).origin }));
}
