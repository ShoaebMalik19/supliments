import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { auditLogs, invitations, memberships } from "@/db/schema";
import {
  acceptInvite,
  inviteMember,
  invitePreview,
  listPendingInvites,
  revokeInvite,
} from "@/modules/tenancy";
import { createTenant, createUser } from "./helpers";

type Tenant = Awaited<ReturnType<typeof createTenant>>;
const ctxOf = (t: Tenant) => ({
  userId: t.owner.id,
  email: t.owner.email,
  orgId: t.org.id,
  role: "owner" as const,
});
const invite = (t: Tenant, email: string, role = "member") =>
  withTenant(t.org.id, (tx) => inviteMember(ctxOf(t), tx, { email, role }));

describe("team invitations", () => {
  it("stores only a hash, lets exactly the invited email join once, with the invited role", async () => {
    const A = await createTenant("Inv A");
    const joiner = await createUser();
    const res = await invite(A, joiner.email.toUpperCase(), "designer");
    const [row] = await privilegedDb()
      .select()
      .from(invitations)
      .where(eq(invitations.id, res.invite.id));
    expect(row!.tokenHash).not.toContain(res.token);
    expect(row!.email).toBe(joiner.email.toLowerCase());
    expect(await invitePreview(res.token)).toMatchObject({ orgName: "Inv A", role: "designer" });

    const stranger = await createUser();
    expect(await acceptInvite(stranger, res.token)).toEqual({ ok: false, reason: "wrong_account" });
    expect(await acceptInvite(joiner, res.token)).toEqual({ ok: true, orgId: A.org.id });
    expect(await acceptInvite(joiner, res.token)).toEqual({ ok: false, reason: "invalid" });
    expect(await invitePreview(res.token)).toBeNull();
    const [m] = await privilegedDb()
      .select()
      .from(memberships)
      .where(eq(memberships.userId, joiner.id));
    expect(m).toMatchObject({ orgId: A.org.id, role: "designer" });
    const audits = await privilegedDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.orgId, A.org.id));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["member.invited", "member.joined"]),
    );
    expect(JSON.stringify(audits)).not.toContain(res.token);
  });

  it("refuses owner role, bad email, existing members; expired or junk tokens are invalid", async () => {
    const A = await createTenant("Inv B");
    await expect(invite(A, "x@example.com", "owner")).rejects.toMatchObject({ status: 400 });
    await expect(invite(A, "not-an-email")).rejects.toMatchObject({ status: 400 });
    await expect(invite(A, A.owner.email)).rejects.toMatchObject({ status: 400 });
    const u = await createUser();
    const res = await invite(A, u.email);
    await privilegedDb()
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, res.invite.id));
    expect(await acceptInvite(u, res.token)).toEqual({ ok: false, reason: "invalid" });
    expect(await acceptInvite(u, "junk")).toEqual({ ok: false, reason: "invalid" });
  });

  it("re-inviting replaces the old link; invites are invisible and unrevokable across orgs", async () => {
    const A = await createTenant("Inv C");
    const B = await createTenant("Inv D");
    const u = await createUser();
    const first = await invite(A, u.email);
    const second = await invite(A, u.email);
    expect(await invitePreview(first.token)).toBeNull();
    expect(await invitePreview(second.token)).not.toBeNull();
    expect(await withTenant(B.org.id, (t) => listPendingInvites(t))).toEqual([]);
    expect(
      await withTenant(B.org.id, (t) => revokeInvite(ctxOf(B), t, second.invite.id)),
    ).toBeNull();
    expect(await withTenant(A.org.id, (t) => listPendingInvites(t))).toHaveLength(1);
    expect(
      await withTenant(A.org.id, (t) => revokeInvite(ctxOf(A), t, second.invite.id)),
    ).not.toBeNull();
    expect(await acceptInvite(u, second.token)).toEqual({ ok: false, reason: "invalid" });
  });
});
