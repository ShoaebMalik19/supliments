import { NextResponse, type NextRequest } from "next/server";
import { refreshSession } from "@/adapters/supabase/middleware";

const PROTECTED = ["/dashboard", "/admin"];

export async function middleware(request: NextRequest) {
  const { response, userId } = await refreshSession(request);
  const path = request.nextUrl.pathname;
  if (!userId && PROTECTED.some((p) => path === p || path.startsWith(`${p}/`))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/cron).*)"],
};
