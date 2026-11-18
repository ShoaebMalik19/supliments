import { timingSafeEqual } from "node:crypto";
import { verifyGithubOidcToken } from "@/adapters/github/oidc";

export const CRON_OIDC_AUDIENCE = "supliments-cron";

function bearer(req: Request) {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function secretMatches(token: string) {
  const secret = process.env.CRON_SECRET;
  return (
    !!secret &&
    token.length === secret.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(secret))
  );
}

/**
 * Scheduler-facing routes accept either the CRON_SECRET bearer (Vercel cron) or a GitHub
 * Actions OIDC token from this repository's main branch (`CRON_GITHUB_REPOSITORY`), so the
 * GitHub workflows need no stored secret. Callers answer 404 on failure.
 */
export async function cronAuthorized(req: Request): Promise<boolean> {
  const token = bearer(req);
  if (!token) return false;
  if (secretMatches(token)) return true;
  const repo = process.env.CRON_GITHUB_REPOSITORY;
  if (!repo || token.split(".").length !== 3) return false;
  try {
    const claims = await verifyGithubOidcToken(token, CRON_OIDC_AUDIENCE);
    return !!claims && claims.repository === repo && claims.ref === "refs/heads/main";
  } catch {
    return false;
  }
}
