import { liveness } from "@/modules/admin/preflight";

export const dynamic = "force-dynamic";

export async function GET() {
  const { ok } = await liveness();
  return Response.json(
    { ok },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
