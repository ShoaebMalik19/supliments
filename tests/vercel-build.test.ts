import { describe, expect, it } from "vitest";
import { sessionPoolerUrl } from "../scripts/vercel-build";

describe("build-time migration connection", () => {
  it("switches Supabase's transaction pooler to session mode and leaves other URLs alone", () => {
    expect(
      sessionPoolerUrl("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"),
    ).toBe("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres");
    expect(sessionPoolerUrl("postgres://u:p@localhost:6543/app")).toBe(
      "postgres://u:p@localhost:6543/app",
    );
  });
});
