import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { auditLogs, memberships, organizations, platformAdmins } from "@/db/schema";
import { setSessionSourceForTests } from "@/modules/auth";
import * as adminOrgRoute from "@/app/api/admin/orgs/[id]/route";
import * as memberRoute from "@/app/api/members/[id]/route";
import { FakeSession } from "./fake-session";
import { createTenant, createUser } from "./helpers";

const session = new FakeSession();
beforeAll(() => setSessionSourceForTests(session));
afterAll(() => setSessionSourceForTests(null));

const patch = (handler: typeof adminOrgRoute.PATCH, id: string, body: unknown) =>
  handler(new Request(`http://test/x/${id}`, { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });

describe("admin authorization is separate from org roles", () => {
  it("an org owner who is not a platform admin gets 404 on admin routes", async () => {
    const A = await createTenant();
    session.actAs(A.owner);
    expect((await patch(adminOrgRoute.PATCH, A.org.id, { status: "suspended" })).status).toBe(404);
  });

  it("a platform admin can suspend any org, and it is audited", async () => {
    const admin = await createUser();
    await privilegedDb().insert(platformAdmins).values({ userId: admin.id });
    const B = await createTenant();
    session.actAs(admin);
    expect((await patch(adminOrgRoute.PATCH, B.org.id, { status: "suspended" })).status).toBe(200);
    const [org] = await privilegedDb()
      .select()
      .from(organizations)
      .where(eq(organizations.id, B.org.id));
    expect(org!.status).toBe("suspended");
    const logs = await privilegedDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, B.org.id), eq(auditLogs.action, "admin.org_status_changed")));
    expect(logs[0]).toMatchObject({ actorType: "admin", actorUserId: admin.id });
  });
});

describe("in-tenant role enforcement", () => {
  it("a member cannot change roles (403 within own org), an owner can", async () => {
    const A = await createTenant();
    const member = await createUser();
    const [m] = await privilegedDb()
      .insert(memberships)
      .values({ orgId: A.org.id, userId: member.id, role: "member" })
      .returning();
    session.actAs(member);
    expect((await patch(memberRoute.PATCH, m!.id, { role: "admin" })).status).toBe(403);
    session.actAs(A.owner);
    expect((await patch(memberRoute.PATCH, m!.id, { role: "admin" })).status).toBe(200);
  });
});
