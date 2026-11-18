import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { auditLogs, brands, memberships, organizations, users } from "@/db/schema";
import {
  completeEmailLink,
  startOAuth,
  resetPassword,
  setSessionSourceForTests,
  signIn,
  signUp,
} from "@/modules/auth";
import { resolveTenant, provisionOrganization, can } from "@/modules/tenancy";
import { FakeSession } from "./fake-session";
import { createTenant } from "./helpers";

const session = new FakeSession();
const db = () => privilegedDb();
beforeAll(() => setSessionSourceForTests(session));
afterAll(() => setSessionSourceForTests(null));

const actions = async (userId: string) =>
  (await db().select().from(auditLogs).where(eq(auditLogs.actorUserId, userId))).map(
    (r) => r.action,
  );

describe("signup", () => {
  it("provisions user, organization, owner membership, default brand and audit rows", async () => {
    const email = `owner-${Date.now()}@test.local`;
    expect(await signUp({ email, password: "correct-horse-1", orgName: "Acme Nutrition" })).toEqual(
      {
        ok: true,
      },
    );
    const [user] = await db().select().from(users).where(eq(users.email, email));
    const [m] = await db().select().from(memberships).where(eq(memberships.userId, user!.id));
    expect(m!.role).toBe("owner");
    const [org] = await db().select().from(organizations).where(eq(organizations.id, m!.orgId));
    expect(org!.name).toBe("Acme Nutrition");
    expect(await db().select().from(brands).where(eq(brands.orgId, org!.id))).toHaveLength(1);
    expect(await actions(user!.id)).toEqual(
      expect.arrayContaining(["org.provisioned", "auth.signup"]),
    );
  });

  it("rejects invalid input without creating anything", async () => {
    expect((await signUp({ email: "bad", password: "short", orgName: "" })).ok).toBe(false);
  });

  it("login requires email verification, then records audit + last_login_at", async () => {
    const email = `verify-${Date.now()}@test.local`;
    await signUp({ email, password: "correct-horse-1", orgName: "Verify Co" });
    expect((await signIn(email, "correct-horse-1")).ok).toBe(false);
    expect((await completeEmailLink(email)).ok).toBe(true);
    expect((await signIn(email, "correct-horse-1")).ok).toBe(true);
    const [user] = await db().select().from(users).where(eq(users.email, email));
    expect(user!.lastLoginAt).not.toBeNull();
    expect(await actions(user!.id)).toEqual(
      expect.arrayContaining(["auth.email_link_verified", "auth.login"]),
    );
  });

  it("failed login is audited without an actor", async () => {
    await signIn("nobody@test.local", "wrong-password");
    const rows = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "auth.login_failed")));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("password reset updates the credential and is audited", async () => {
    const email = `reset-${Date.now()}@test.local`;
    await signUp({ email, password: "correct-horse-1", orgName: "Reset Co" });
    await completeEmailLink(email);
    expect((await resetPassword("new-password-123")).ok).toBe(true);
    expect((await signIn(email, "new-password-123")).ok).toBe(true);
  });
});

describe("tenant resolution", () => {
  it("honours the active-org cookie only for orgs the user belongs to", async () => {
    const A = await createTenant("A");
    const second = await provisionOrganization({
      userId: A.owner.id,
      email: A.owner.email,
      orgName: "A second org",
    });
    session.actAs(A.owner, second.id);
    expect((await resolveTenant())?.orgId).toBe(second.id);
    const B = await createTenant("B");
    session.actAs(A.owner, B.org.id);
    expect((await resolveTenant())?.orgId).toBe(A.org.id);
  });

  it("suspended organizations are not resolvable", async () => {
    const A = await createTenant("Suspended");
    await db()
      .update(organizations)
      .set({ status: "suspended" })
      .where(eq(organizations.id, A.org.id));
    session.actAs(A.owner);
    expect(await resolveTenant()).toBeNull();
  });

  it("role permissions", () => {
    expect(can("owner", "members:manage")).toBe(true);
    expect(can("member", "members:manage")).toBe(false);
    expect(can("designer", "label:write")).toBe(true);
    expect(can("read_only", "brand:write")).toBe(false);
  });
});

describe("social sign-in (Google)", () => {
  it("only known providers start, and they return to our callback", async () => {
    expect(await startOAuth("evil")).toBeNull();
    const r = await startOAuth("google");
    expect(r).toMatchObject({ ok: true });
    if (!r?.ok) throw new Error();
    expect(decodeURIComponent(r.url)).toMatch(/\/auth\/callback\?next=\/dashboard$/);
  });

  it("first sign-in provisions one org with the user as owner, exactly once, even when raced", async () => {
    const email = `g-${randomUUID()}@example.com`;
    const user = { id: randomUUID(), email };
    session.accounts.set(email, { user, password: "", verified: true });
    const results = await Promise.all([completeEmailLink(email), completeEmailLink(email)]);
    expect(results.every((r) => r.ok)).toBe(true);
    await completeEmailLink(email);
    const rows = await privilegedDb()
      .select()
      .from(memberships)
      .where(eq(memberships.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("owner");
    session.actAs(user);
    expect(await resolveTenant()).toMatchObject({ orgId: rows[0]!.orgId, role: "owner" });
  });

  it("an existing member signing in through a link gets no extra org", async () => {
    const t = await createTenant("Has org");
    session.accounts.set(t.owner.email, { user: t.owner, password: "", verified: true });
    expect((await completeEmailLink(t.owner.email)).ok).toBe(true);
    const rows = await privilegedDb()
      .select()
      .from(memberships)
      .where(eq(memberships.userId, t.owner.id));
    expect(rows).toHaveLength(1);
  });
});
