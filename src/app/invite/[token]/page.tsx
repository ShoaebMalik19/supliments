import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACTIVE_ORG_COOKIE, session } from "@/modules/auth";
import { acceptInvite, invitePreview } from "@/modules/tenancy";

export const dynamic = "force-dynamic";

async function accept(form: FormData) {
  "use server";
  const user = await session().auth().currentUser();
  if (!user) redirect("/login");
  const token = String(form.get("token") ?? "");
  const res = await acceptInvite(user, token);
  if (!res.ok) redirect(`/invite/${encodeURIComponent(token)}?error=${res.reason}`);
  (await cookies()).set(ACTIVE_ORG_COOKIE, res.orgId, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
  });
  redirect("/dashboard");
}

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const preview = await invitePreview(token);
  if (!preview)
    return (
      <main>
        <h1>Invitation</h1>
        <p>This invitation is invalid, already used or expired. Ask for a new one.</p>
      </main>
    );
  const user = await session().auth().currentUser();
  return (
    <main>
      <h1>Join {preview.orgName}</h1>
      <p>
        You were invited as <strong>{preview.role}</strong> for {preview.email}.
      </p>
      {error === "wrong_account" && (
        <p role="alert">You are signed in with a different email. Sign in as {preview.email}.</p>
      )}
      {user ? (
        <form action={accept}>
          <input type="hidden" name="token" value={token} />
          <button type="submit">Accept invitation</button>
        </form>
      ) : (
        <p>
          <Link href="/login">Log in</Link> or <Link href="/signup">sign up</Link> as{" "}
          {preview.email}, then open this link again.
        </p>
      )}
    </main>
  );
}
