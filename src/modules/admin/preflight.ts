import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { privilegedDb } from "@/db/privileged";
import { withTenant } from "@/db/tenant";
import { brands } from "@/db/schema";
import { apiVersionSupportDaysLeft, SHOPIFY_API_VERSION } from "@/adapters/shopify";
import { supabaseAuthAdmin } from "@/adapters/supabase/admin";
import { assetsBucket } from "@/modules/assets";
import { storage } from "@/modules/assets/storage";
import type { AuthAdmin } from "@/modules/auth/provider";
import { decryptSecret, encryptSecret } from "@/modules/integrations/secrets";
import { STALE_LOCK_SECONDS } from "@/modules/jobs";
import { GOLDEN_HASHES, goldenRender } from "@/modules/labels/golden";
import journal from "../../../db/migrations/meta/_journal.json";

export type CheckStatus = "ok" | "warn" | "fail";
export type Check = { id: string; status: CheckStatus; detail: string };

const REQUIRED_ENV = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SITE_URL",
  "INTEGRATION_ENCRYPTION_KEY",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "CRON_SECRET",
] as const;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

async function run(id: string, fn: () => Promise<[CheckStatus, string]>): Promise<Check> {
  try {
    const [status, detail] = await fn();
    return { id, status, detail };
  } catch (e) {
    return { id, status: "fail", detail: msg(e) };
  }
}

const count = async (q: ReturnType<typeof sql>) =>
  Number(((await privilegedDb().execute(q)) as unknown as { n: string }[])[0]!.n);

/**
 * Everything the deployed app needs in order to run the order loop, checked from inside the
 * deployed runtime. Details never contain secret values. `fail` blocks go-live; `warn` does not.
 */
export async function preflight(
  opts: { origin?: string; auth?: AuthAdmin; env?: Record<string, string | undefined> } = {},
): Promise<{ ok: boolean; checks: Check[] }> {
  const env = opts.env ?? process.env;
  const auth = opts.auth ?? supabaseAuthAdmin;
  const checks: Check[] = [];

  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  checks.push({
    id: "env.required",
    status: missing.length ? "fail" : "ok",
    detail: missing.length ? `missing: ${missing.join(", ")}` : `${REQUIRED_ENV.length} set`,
  });
  checks.push(
    await run("env.site_url", async () => {
      const site = env.NEXT_PUBLIC_SITE_URL;
      if (!site) return ["fail", "NEXT_PUBLIC_SITE_URL not set"];
      const u = new URL(site);
      if (u.protocol !== "https:" && u.hostname !== "localhost")
        return ["fail", "NEXT_PUBLIC_SITE_URL must be https (OAuth and email links use it)"];
      if (opts.origin && new URL(opts.origin).host !== u.host)
        return [
          "fail",
          `NEXT_PUBLIC_SITE_URL host (${u.host}) differs from this deployment (${new URL(opts.origin).host}); Shopify OAuth redirects would go elsewhere`,
        ];
      return ["ok", u.host];
    }),
  );
  checks.push(
    await run("secrets.encryption_key", async () => {
      const { ciphertext, keyId } = encryptSecret("preflight");
      return decryptSecret(ciphertext, keyId) === "preflight"
        ? ["ok", `key id ${keyId} round-trips`]
        : ["fail", "round-trip mismatch"];
    }),
  );

  checks.push(
    await run("db.migrations", async () => {
      const applied = await count(sql`select count(*) n from drizzle.__drizzle_migrations`);
      const expected = journal.entries.length;
      return applied === expected
        ? ["ok", `${applied} applied`]
        : ["fail", `${applied} applied, this build expects ${expected}: run npm run db:migrate`];
    }),
  );
  checks.push(
    await run("db.tenant_isolation", async () => {
      const total = await count(sql`select count(*) n from brands`);
      const seen = await withTenant(randomUUID(), (t) =>
        t.tx.select({ id: brands.id }).from(brands),
      );
      if (seen.length) return ["fail", `a tenant with no data can see ${seen.length} brands`];
      return [
        "ok",
        `app_user role works through this connection; 0 of ${total} brands visible to a stranger`,
      ];
    }),
  );
  checks.push(
    await run("db.api_roles_locked_out", async () => {
      const n = await count(sql`
        select count(*) n from pg_tables t, unnest(array['anon','authenticated']) r
        where t.schemaname = 'public' and exists (select 1 from pg_roles where rolname = r)
          and has_table_privilege(r, format('public.%I', t.tablename), 'SELECT')`);
      return n
        ? ["fail", `${n} table grants to anon/authenticated`]
        : ["ok", "no public-API table access"];
    }),
  );

  const bucket = assetsBucket();
  checks.push(
    await run("storage.bucket_private", async () => {
      const v = await storage().bucketVisibility(bucket);
      if (v === "private") return ["ok", `${bucket} is private`];
      return ["fail", v === "public" ? `${bucket} is PUBLIC` : `bucket ${bucket} not found`];
    }),
  );
  checks.push(
    await run("storage.roundtrip", async () => {
      const key = `platform/preflight/${randomBytes(8).toString("hex")}`;
      const data = new Uint8Array(randomBytes(32));
      await storage().putObject(bucket, key, data, "application/octet-stream");
      const back = await storage().getObject(bucket, key);
      await storage().remove(bucket, key);
      return back && Buffer.from(back).equals(Buffer.from(data))
        ? ["ok", "write, read and delete work"]
        : ["fail", "object read back differs"];
    }),
  );
  checks.push(
    await run("auth.reachable", async () => {
      const h = await auth.health();
      if (!h.reachable) return ["fail", `auth service: ${h.detail}`];
      return h.emailSignup === false
        ? ["fail", "email signup is disabled in Supabase Auth"]
        : ["ok", "reachable, email signup on"];
    }),
  );

  checks.push(
    await run("render.golden", async () => {
      const r = await goldenRender();
      const same = JSON.stringify(r.hashes) === JSON.stringify(GOLDEN_HASHES);
      return same
        ? [
            "ok",
            `labels render pixel-identically here (sharp ${r.sharp.sharp}, node ${process.version})`,
          ]
        : ["fail", `pixel hashes differ from the pinned ones: ${JSON.stringify(r.hashes)}`];
    }),
  );
  checks.push(
    await run("shopify.config", async () => {
      const days = apiVersionSupportDaysLeft();
      if (days < 0) return ["fail", `Admin API ${SHOPIFY_API_VERSION} is out of support`];
      return [
        days < 90 ? "warn" : "ok",
        `Admin API ${SHOPIFY_API_VERSION}, ${days} days of support left`,
      ];
    }),
  );

  const seedChecks: [string, ReturnType<typeof sql>, string][] = [
    [
      "seed.fee_schedule",
      sql`select count(*) n from fee_schedules where effective_from <= now() and (effective_to is null or effective_to > now())`,
      "no fee schedule in force: orders cannot be priced",
    ],
    [
      "seed.catalog",
      sql`select count(*) n from skus s join catalog_products p on p.id = s.catalog_product_id where p.status = 'active' and s.is_active`,
      "no active catalog SKU",
    ],
    ["seed.label_template", sql`select count(*) n from label_templates`, "no label template"],
    [
      "seed.fulfillment_center",
      sql`select count(*) n from fulfillment_centers where is_active`,
      "no active fulfillment center: paid orders cannot be routed",
    ],
    [
      "seed.partner_sku_codes",
      sql`select count(*) n from partner_sku_mappings`,
      "no partner SKU codes: dispatch export will hold every order",
    ],
    [
      "seed.platform_admin",
      sql`select count(*) n from platform_admins`,
      "no platform admin: nobody can approve labels or mark orders paid",
    ],
  ];
  for (const [id, q, problem] of seedChecks)
    checks.push(
      await run(id, async () => {
        const n = await count(q);
        return n ? ["ok", `${n}`] : ["fail", `${problem} (run npm run db:seed)`];
      }),
    );

  checks.push(
    await run("queue.health", async () => {
      const [r] = (await privilegedDb().execute(sql`
        select count(*) filter (where status = 'pending') pending,
               count(*) filter (where status = 'dead') dead,
               count(*) filter (where status = 'running' and locked_at < now() - make_interval(secs => ${STALE_LOCK_SECONDS})) stale,
               coalesce(extract(epoch from now() - min(run_at) filter (where status = 'pending' and run_at <= now())), 0)::int oldest_due_s
        from job_queue`)) as unknown as {
        pending: string;
        dead: string;
        stale: string;
        oldest_due_s: number;
      }[];
      const detail = `pending ${r!.pending}, dead ${r!.dead}, stale ${r!.stale}, oldest due ${r!.oldest_due_s}s`;
      if (Number(r!.dead) || Number(r!.stale) || r!.oldest_due_s > 1800) return ["warn", detail];
      return ["ok", detail];
    }),
  );

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}
