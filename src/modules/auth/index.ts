import { eq } from "drizzle-orm";
import { z } from "zod";
import { privilegedDb } from "@/db/privileged";
import { users } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { provisionOrganization } from "@/modules/tenancy";
import { session } from "./session";

export { session, setSessionSourceForTests, ACTIVE_ORG_COOKIE } from "./session";
export type { AuthProvider, AuthUser, SessionSource } from "./provider";

const siteUrl = () => process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const signUpInput = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10).max(128),
  orgName: z.string().trim().min(2).max(100),
});

type Outcome = { ok: true } | { ok: false; error: string };

async function audit(action: string, actorUserId: string | null, orgId: string | null = null) {
  const meta = await session().requestMeta();
  await recordAudit({ orgId, actorUserId, actorType: "user", action, ...meta });
}

export async function signUp(raw: unknown): Promise<Outcome> {
  const parsed = signUpInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid signup details" };
  const { email, password, orgName } = parsed.data;
  const res = await session()
    .auth()
    .signUp(email, password, `${siteUrl()}/auth/callback?next=/dashboard`);
  if (!res.ok) return { ok: false, error: res.error };
  if (!res.user) return { ok: false, error: "Signup failed" };
  const org = await provisionOrganization({ userId: res.user.id, email, orgName });
  await audit("auth.signup", res.user.id, org.id);
  return { ok: true };
}

export async function signIn(email: string, password: string): Promise<Outcome> {
  const res = await session().auth().signIn(email, password);
  if (!res.ok || !res.user) {
    await audit("auth.login_failed", null);
    return { ok: false, error: "Invalid email or password, or email not verified" };
  }
  await privilegedDb()
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, res.user.id));
  await audit("auth.login", res.user.id);
  return { ok: true };
}

export async function signOut() {
  const user = await session().auth().currentUser();
  await session().auth().signOut();
  if (user) await audit("auth.logout", user.id);
}

export async function requestPasswordReset(email: string) {
  await session()
    .auth()
    .sendPasswordReset(email, `${siteUrl()}/auth/callback?next=/reset-password`);
  await audit("auth.password_reset_requested", null);
}

export async function resetPassword(password: string): Promise<Outcome> {
  if (password.length < 10) return { ok: false, error: "Password must be at least 10 characters" };
  const res = await session().auth().updatePassword(password);
  if (!res.ok) return { ok: false, error: res.error };
  await audit("auth.password_reset", res.user?.id ?? null);
  return { ok: true };
}

export async function completeEmailLink(code: string): Promise<Outcome> {
  const res = await session().auth().exchangeCode(code);
  if (!res.ok) return { ok: false, error: res.error };
  await audit("auth.email_link_verified", res.user?.id ?? null);
  return { ok: true };
}
