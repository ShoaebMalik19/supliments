import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setGithubOidcFetchForTests } from "@/adapters/github/oidc";
import { CRON_OIDC_AUDIENCE, cronAuthorized } from "@/lib/cron-auth";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";
const REPO = "acme/app";
const now = () => Math.floor(Date.now() / 1000);

function token(
  claims: Record<string, unknown> = {},
  opts: { kid?: string; key?: typeof privateKey } = {},
) {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT", kid: opts.kid ?? KID });
  const body = enc({
    iss: "https://token.actions.githubusercontent.com",
    aud: CRON_OIDC_AUDIENCE,
    repository: REPO,
    ref: "refs/heads/main",
    exp: now() + 300,
    nbf: now() - 5,
    ...claims,
  });
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), opts.key ?? privateKey);
  return `${head}.${body}.${sig.toString("base64url")}`;
}

const req = (bearer: string) =>
  new Request("https://app.test/api/cron/jobs", { headers: { authorization: `Bearer ${bearer}` } });

let jwksFetches = 0;
beforeAll(() => {
  setGithubOidcFetchForTests(async () => {
    jwksFetches++;
    return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID }] });
  });
});
afterAll(() => {
  setGithubOidcFetchForTests(null);
  delete process.env.CRON_GITHUB_REPOSITORY;
});
beforeEach(() => {
  process.env.CRON_GITHUB_REPOSITORY = REPO;
  process.env.CRON_SECRET = "s3cret-value-for-tests";
});

describe("cron route authorization", () => {
  it("accepts the CRON_SECRET bearer and a main-branch OIDC token from the configured repo", async () => {
    expect(await cronAuthorized(req("s3cret-value-for-tests"))).toBe(true);
    expect(await cronAuthorized(req(token()))).toBe(true);
  });

  it.each([
    ["another repository", { repository: "evil/app" }],
    ["another branch", { ref: "refs/heads/feature" }],
    ["a pull request ref", { ref: "refs/pull/1/merge" }],
    ["another audience", { aud: "something-else" }],
    ["another issuer", { iss: "https://evil.example" }],
    ["an expired token", { exp: now() - 120 }],
    ["a not-yet-valid token", { nbf: now() + 600 }],
  ])("refuses %s", async (_name, claims) => {
    expect(await cronAuthorized(req(token(claims)))).toBe(false);
  });

  it("refuses a token signed by another key, an unknown key id, junk and a missing header", async () => {
    expect(await cronAuthorized(req(token({}, { key: other.privateKey })))).toBe(false);
    expect(await cronAuthorized(req(token({}, { kid: "nope" })))).toBe(false);
    expect(await cronAuthorized(req("a.b.c"))).toBe(false);
    expect(await cronAuthorized(new Request("https://app.test/api/cron/jobs"))).toBe(false);
  });

  it("OIDC is off unless CRON_GITHUB_REPOSITORY is set", async () => {
    delete process.env.CRON_GITHUB_REPOSITORY;
    expect(await cronAuthorized(req(token()))).toBe(false);
  });

  it("caches GitHub's keys instead of fetching per request", async () => {
    const before = jwksFetches;
    for (let i = 0; i < 3; i++) await cronAuthorized(req(token()));
    expect(jwksFetches - before).toBeLessThanOrEqual(1);
  });
});
