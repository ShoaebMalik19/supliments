import { describe, expect, it } from "vitest";
import { classify } from "../scripts/lib/isolation-probe";

const r = (status: number, body: string, headers: Record<string, string> = {}) => ({
  status,
  body,
  headers: new Headers(headers),
});

describe("live isolation probe classification", () => {
  it("an egress-proxy 403 is INVALID, not 'denied' (this once produced a false all-clear)", () => {
    expect(
      classify(
        r(403, "Host not in allowlist: x.supabase.co.", { "x-deny-reason": "host_not_allowed" }),
      ),
    ).toBe("invalid");
    expect(classify(r(403, "<html>Forbidden</html>"))).toBe("invalid");
    expect(classify(r(502, '{"message":"bad gateway"}'))).toBe("invalid");
  });

  it("only Supabase's own refusals count as denied", () => {
    expect(
      classify(r(401, '{"code":"42501","message":"permission denied for table orders"}')),
    ).toBe("denied");
    expect(classify(r(404, '{"code":"PGRST202","message":"Could not find the function"}'))).toBe(
      "denied",
    );
    expect(
      classify(r(400, '{"statusCode":"403","error":"Unauthorized","message":"new row violates"}')),
    ).toBe("denied");
  });

  it("any 2xx is a leak", () => {
    expect(classify(r(200, "[]"))).toBe("leak");
    expect(classify(r(201, ""))).toBe("leak");
  });
});
