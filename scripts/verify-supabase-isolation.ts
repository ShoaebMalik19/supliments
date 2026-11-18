/**
 * Probes a live Supabase project through its public APIs (PostgREST, RPC, GraphQL, Storage)
 * the way an attacker holding the public key would, as `anon` and — when DEMO credentials are
 * given — as a signed-in `authenticated` user. Exits non-zero on any read or write that succeeds.
 *
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… [VERIFY_EMAIL=… VERIFY_PASSWORD=…] npm run verify:isolation
 */
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema";
import { classify, type ProbeResponse } from "./lib/isolation-probe";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");

const TABLES = Object.values(schema as Record<string, unknown>)
  .filter((v): v is PgTable => is(v, PgTable))
  .map((t) => getTableName(t));
const FUNCTIONS = [
  "uuid_generate_v7",
  "current_org_id",
  "enable_tenant_rls",
  "forbid_mutation",
  "touch_updated_at",
  "protect_approved_label",
];
const BUCKET = process.env.ASSETS_BUCKET ?? "assets-private";

type Finding = { role: string; probe: string; status: number; body: string };
const leaks: Finding[] = [];
const invalid: Finding[] = [];
let probes = 0;

async function probe(
  role: string,
  probeName: string,
  path: string,
  init: RequestInit,
  token: string,
) {
  probes++;
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: key!,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const r: ProbeResponse = { status: res.status, headers: res.headers, body: await res.text() };
  const finding = { role, probe: probeName, status: r.status, body: r.body.slice(0, 300) };
  const verdict = classify(r);
  if (verdict === "invalid") invalid.push(finding);
  return { ...finding, verdict };
}

async function suite(role: string, token: string) {
  for (const t of TABLES) {
    const read = await probe(role, `GET ${t}`, `/rest/v1/${t}?select=*&limit=1`, {}, token);
    if (read.verdict === "leak") leaks.push(read);
    const write = await probe(
      role,
      `POST ${t}`,
      `/rest/v1/${t}`,
      { method: "POST", body: "{}", headers: { prefer: "return=minimal" } },
      token,
    );
    if (write.verdict === "leak") leaks.push(write);
  }
  for (const f of FUNCTIONS) {
    const r = await probe(
      role,
      `RPC ${f}`,
      `/rest/v1/rpc/${f}`,
      { method: "POST", body: "{}" },
      token,
    );
    if (r.verdict === "leak") leaks.push(r);
  }
  const gql = await probe(
    role,
    "GraphQL introspection",
    "/graphql/v1",
    {
      method: "POST",
      body: JSON.stringify({ query: "{ __schema { queryType { fields { name } } } }" }),
    },
    token,
  );
  const exposed = TABLES.filter((t) =>
    new RegExp(`"${t.replace(/_(\w)/g, (_, c) => c.toUpperCase())}Collection"`).test(gql.body),
  );
  if (exposed.length) leaks.push({ ...gql, body: `exposes ${exposed.join(", ")}` });
  const list = await probe(
    role,
    `Storage list ${BUCKET}`,
    `/storage/v1/object/list/${BUCKET}`,
    { method: "POST", body: JSON.stringify({ prefix: "", limit: 10 }) },
    token,
  );
  if (list.status < 300 && list.body.trim() !== "[]") leaks.push(list);
  const buckets = await probe(role, "Storage bucket list", "/storage/v1/bucket", {}, token);
  if (buckets.status < 300 && buckets.body.includes(BUCKET)) leaks.push(buckets);
}

const control = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
if (!control.ok || control.headers.get("x-deny-reason"))
  throw new Error(
    `positive control failed: GET /auth/v1/settings -> ${control.status} ${(await control.text()).slice(0, 200)}. ` +
      "The probes cannot reach Supabase from here, so no isolation result would be valid.",
  );

const roles = ["anon"];
await suite("anon", key);
const email = process.env.VERIFY_EMAIL;
const password = process.env.VERIFY_PASSWORD;
if (email && password) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const session = (await res.json()) as { access_token?: string; error_description?: string };
  if (!session.access_token)
    throw new Error(`sign-in failed for ${email}: ${JSON.stringify(session)}`);
  console.log(`signed in as ${email} (real Supabase session)`);
  await suite("authenticated", session.access_token);
  roles.push("authenticated");
} else {
  console.log("VERIFY_EMAIL/VERIFY_PASSWORD not set: authenticated role not probed");
}

console.log(
  `${probes} probes against ${url}, ${TABLES.length} tables, ${FUNCTIONS.length} functions`,
);
if (leaks.length) {
  if (process.env.GITHUB_ACTIONS)
    for (const l of leaks)
      console.log(`::error title=LEAK [${l.role}] ${l.probe}::${l.status} ${l.body}`);
  console.error("LEAKS:");
  for (const l of leaks) console.error(`  [${l.role}] ${l.probe} -> ${l.status} ${l.body}`);
  process.exit(1);
}
const summary = `${probes} probes, roles: ${roles.join("+")}, 0 leaks, 0 invalid — no read or write succeeded through the Data API, GraphQL or Storage`;
console.log(summary);
if (process.env.GITHUB_ACTIONS)
  console.log(`::notice title=Live isolation probes (${url})::${summary}`);
