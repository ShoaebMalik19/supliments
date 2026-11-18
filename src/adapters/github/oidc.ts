import { createPublicKey, verify, type webcrypto } from "node:crypto";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const JWKS_TTL_MS = 60 * 60 * 1000;

export type GithubOidcClaims = {
  iss: string;
  aud: string | string[];
  repository: string;
  ref: string;
  event_name?: string;
  workflow?: string;
  exp: number;
  nbf?: number;
  iat?: number;
};

type Jwk = webcrypto.JsonWebKey & { kid?: string };
type Fetcher = (url: string) => Promise<Response>;

let fetcher: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(5000) });
let cache: { at: number; keys: Jwk[] } | null = null;

export function setGithubOidcFetchForTests(f: Fetcher | null) {
  fetcher = f ?? ((url) => fetch(url, { signal: AbortSignal.timeout(5000) }));
  cache = null;
}

async function keys(force = false): Promise<Jwk[]> {
  if (!force && cache && Date.now() - cache.at < JWKS_TTL_MS) return cache.keys;
  const res = await fetcher(JWKS_URL);
  if (!res.ok) throw new Error(`GitHub JWKS returned HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  cache = { at: Date.now(), keys: body.keys ?? [] };
  return cache.keys;
}

const b64url = (s: string) => Buffer.from(s, "base64url");

/**
 * Verifies a GitHub Actions OIDC token (RS256, GitHub's published keys, issuer, audience, time).
 * Returns its claims, or null for anything that does not verify. Repository/ref policy is the
 * caller's.
 */
export async function verifyGithubOidcToken(
  token: string,
  audience: string,
  now = Date.now(),
): Promise<GithubOidcClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: GithubOidcClaims;
  try {
    header = JSON.parse(b64url(parts[0]!).toString("utf8"));
    claims = JSON.parse(b64url(parts[1]!).toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  let jwk = (await keys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keys(true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const ok = verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    b64url(parts[2]!),
  );
  if (!ok) return null;
  const s = Math.floor(now / 1000);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== GITHUB_OIDC_ISSUER || !auds.includes(audience)) return null;
  if (typeof claims.exp !== "number" || claims.exp < s - 30) return null;
  if (typeof claims.nbf === "number" && claims.nbf > s + 30) return null;
  return claims;
}
