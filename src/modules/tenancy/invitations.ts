import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { privilegedDb } from "@/db/privileged";
import type { TenantDb } from "@/db/tenant";
import { invitations, memberships, organizations } from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { badRequest } from "@/lib/http";
import type { TenantContext } from "./index";

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
const INVITABLE = ["admin", "member", "designer", "read_only"] as const;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const inviteInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(INVITABLE),
});

/**
 * Creates a single-use invitation; only the token's hash is stored. Re-inviting the same email
 * replaces the earlier pending invite. The caller delivers `token` (email or copy-once link).
 */
export async function inviteMember(ctx: TenantContext, t: TenantDb, raw: unknown) {
  const r = inviteInput.safeParse(raw);
  if (!r.success) throw badRequest("a valid email and a role (not owner) are required");
  const { email, role } = r.data;
  const already = await t.tx.execute(
    sql`select 1 from memberships m join users u on u.id = m.user_id
        where m.org_id = ${t.orgId} and lower(u.email) = ${email} limit 1`,
  );
  if (already.length) throw badRequest("that person is already a member");
  await t.tx
    .delete(invitations)
    .where(
      and(
        eq(invitations.orgId, t.orgId),
        eq(invitations.email, email),
        isNull(invitations.acceptedAt),
      ),
    );
  const token = randomBytes(32).toString("base64url");
  const invite = await t.insert(invitations, {
    email,
    role,
    tokenHash: sha256(token),
    invitedBy: ctx.userId,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  });
  const [org] = await t.tx.select().from(organizations).where(eq(organizations.id, t.orgId));
  await recordAudit(
    {
      orgId: t.orgId,
      actorUserId: ctx.userId,
      actorType: "user",
      action: "member.invited",
      entityType: "invitation",
      entityId: invite.id,
      after: { email, role },
    },
    t.tx,
  );
  return { invite: { id: invite.id, email, role }, token, orgName: org?.name ?? "" };
}

export async function listPendingInvites(t: TenantDb) {
  return t.tx
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.orgId, t.orgId),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    );
}

export async function revokeInvite(ctx: TenantContext, t: TenantDb, id: string) {
  if (!z.uuid().safeParse(id).success) return null;
  const [gone] = await t.tx
    .delete(invitations)
    .where(
      and(eq(invitations.id, id), eq(invitations.orgId, t.orgId), isNull(invitations.acceptedAt)),
    )
    .returning({ id: invitations.id, email: invitations.email });
  if (gone)
    await recordAudit(
      {
        orgId: t.orgId,
        actorUserId: ctx.userId,
        actorType: "user",
        action: "member.invite_revoked",
        entityType: "invitation",
        entityId: gone.id,
        after: { email: gone.email },
      },
      t.tx,
    );
  return gone ?? null;
}

/** What the accept page may show before acceptance. Null for unknown, used or expired tokens. */
export async function invitePreview(token: string) {
  if (!token || token.length > 100) return null;
  const [row] = await privilegedDb()
    .select({
      email: invitations.email,
      role: invitations.role,
      orgName: organizations.name,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
    })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(eq(invitations.tokenHash, sha256(token)));
  if (!row || row.acceptedAt || row.expiresAt <= new Date()) return null;
  return { email: row.email, role: row.role, orgName: row.orgName };
}

export type AcceptOutcome =
  { ok: true; orgId: string } | { ok: false; reason: "invalid" | "wrong_account" };

/** Accepts for the signed-in user; the invite is bound to its email address and used once. */
export async function acceptInvite(
  user: { id: string; email: string },
  token: string,
): Promise<AcceptOutcome> {
  if (!token || token.length > 100) return { ok: false, reason: "invalid" };
  return privilegedDb().transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, sha256(token)))
      .for("update");
    if (!inv || inv.acceptedAt || inv.expiresAt <= new Date())
      return { ok: false, reason: "invalid" };
    if (inv.email.toLowerCase() !== user.email.trim().toLowerCase())
      return { ok: false, reason: "wrong_account" };
    await tx
      .insert(memberships)
      .values({ orgId: inv.orgId, userId: user.id, role: inv.role, acceptedAt: new Date() })
      .onConflictDoNothing();
    await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));
    await recordAudit(
      {
        orgId: inv.orgId,
        actorUserId: user.id,
        actorType: "user",
        action: "member.joined",
        entityType: "invitation",
        entityId: inv.id,
        after: { role: inv.role },
      },
      tx,
    );
    return { ok: true, orgId: inv.orgId };
  });
}
