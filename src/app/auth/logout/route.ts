import { NextResponse, type NextRequest } from "next/server";
import { signOut } from "@/modules/auth";

export async function POST(req: NextRequest) {
  await signOut();
  return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
}
