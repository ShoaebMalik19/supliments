export type ProbeResponse = { status: number; headers: Headers; body: string };
export type Verdict = "leak" | "denied" | "invalid";

/**
 * A probe only counts as "denied" when Supabase itself refused it. Anything else (a proxy or
 * firewall block, an HTML error page, a timeout) means the probe never reached the policy under
 * test, so the run is invalid rather than passing.
 */
export function classify(r: ProbeResponse): Verdict {
  if (r.headers.get("x-deny-reason")) return "invalid";
  if (r.status >= 200 && r.status < 300) return "leak";
  if (![400, 401, 403, 404, 405].includes(r.status)) return "invalid";
  try {
    const body = JSON.parse(r.body) as Record<string, unknown>;
    const fromSupabase =
      typeof body.code === "string" ||
      typeof body.code === "number" ||
      typeof body.message === "string" ||
      typeof body.msg === "string" ||
      typeof body.error === "string" ||
      Array.isArray(body.errors);
    return fromSupabase ? "denied" : "invalid";
  } catch {
    return "invalid";
  }
}
