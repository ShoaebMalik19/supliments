import { NextResponse, type NextRequest } from "next/server";
import { startOAuth } from "@/modules/auth";

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const res = await startOAuth((await params).provider);
  if (!res) return new Response(null, { status: 404 });
  if (!res.ok)
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(res.error)}`, req.url));
  return NextResponse.redirect(res.url);
}
