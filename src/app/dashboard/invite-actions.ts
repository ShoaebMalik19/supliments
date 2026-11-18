"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/db/tenant";
import { inviteEmail, sendDirectEmail } from "@/modules/notifications";
import { inviteMember, requireTenant, revokeInvite } from "@/modules/tenancy";
import { HttpError } from "@/lib/http";

export type InviteState = { error?: string; sentTo?: string; shareLink?: string } | null;

const siteUrl = () =>
  (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");

export async function invite(_prev: InviteState, form: FormData): Promise<InviteState> {
  const ctx = await requireTenant("members:manage");
  try {
    const res = await withTenant(ctx.orgId, (t) =>
      inviteMember(ctx, t, { email: form.get("email"), role: form.get("role") }),
    );
    const acceptUrl = `${siteUrl()}/invite/${res.token}`;
    const sent = await sendDirectEmail({
      to: res.invite.email,
      ...inviteEmail({ orgName: res.orgName, inviterEmail: ctx.email, acceptUrl }),
      idempotencyKey: `invite-${res.invite.id}`,
    });
    revalidatePath("/dashboard");
    return sent ? { sentTo: res.invite.email } : { shareLink: acceptUrl };
  } catch (e) {
    return { error: e instanceof HttpError ? e.message : "Could not create the invitation" };
  }
}

export async function revoke(form: FormData) {
  const ctx = await requireTenant("members:manage");
  await withTenant(ctx.orgId, (t) => revokeInvite(ctx, t, String(form.get("id"))));
  revalidatePath("/dashboard");
}
