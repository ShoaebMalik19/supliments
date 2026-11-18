import { liveness } from "@/modules/admin/preflight";

export const dynamic = "force-dynamic";

export async function GET() {
  const { ok } = await liveness();
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null;
  return Response.json(
    { ok, commit },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
