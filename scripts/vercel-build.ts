/**
 * Vercel build step before `next build`. On production builds only (previews share the database):
 * apply pending migrations (fatal: the code expects them) and run the idempotent seed (non-fatal:
 * a seed problem must not block a deploy; preflight reports missing seed data).
 */
import { spawnSync } from "node:child_process";

export function sessionPoolerUrl(url: string) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith(".pooler.supabase.com") && u.port === "6543") u.port = "5432";
    return u.toString();
  } catch {
    return url;
  }
}

function run(script: string, env: NodeJS.ProcessEnv) {
  return spawnSync("npx", ["tsx", script], { stdio: "inherit", env }).status === 0;
}

if (process.env.VERCEL_ENV === "production" && process.env.DATABASE_URL) {
  const env = { ...process.env, DATABASE_URL: sessionPoolerUrl(process.env.DATABASE_URL) };
  if (!run("scripts/migrate.ts", env)) {
    console.error(
      "vercel-build: migrations failed; aborting the deploy (the live version stays up)",
    );
    process.exit(1);
  }
  if (process.env.SKIP_BUILD_SEED !== "1" && !run("scripts/seed.ts", env))
    console.warn("vercel-build: seed failed; deploying anyway (preflight will report it)");
} else {
  console.log(`vercel-build: no migrations on ${process.env.VERCEL_ENV ?? "local"} builds`);
}
