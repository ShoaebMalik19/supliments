import { cookies, headers } from "next/headers";
import { supabaseAuth } from "@/adapters/supabase/auth";
import type { SessionSource } from "./provider";

export const ACTIVE_ORG_COOKIE = "active_org";

const nextSession: SessionSource = {
  auth: () => supabaseAuth,
  async preferredOrgId() {
    return (await cookies()).get(ACTIVE_ORG_COOKIE)?.value ?? null;
  },
  async requestMeta() {
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    return { ip, userAgent: h.get("user-agent") };
  },
};

let source: SessionSource = nextSession;

export const session = () => source;

export function setSessionSourceForTests(s: SessionSource | null) {
  source = s ?? nextSession;
}
