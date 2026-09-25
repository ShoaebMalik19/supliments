import { NextResponse, type NextRequest } from "next/server";
import { completeEmailLink } from "@/modules/auth";

const SAFE_NEXT = new Set(["/dashboard", "/reset-password"]);

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const nextParam = req.nextUrl.searchParams.get("next") ?? "/dashboard";
  const next = SAFE_NEXT.has(nextParam) ? nextParam : "/dashboard";
  const ok = code ? (await completeEmailLink(code)).ok : false;
  return NextResponse.redirect(new URL(ok ? next : "/login?error=link", req.url));
}
