# Execution plan: from "code complete" to "one real order shipped"

Status as of 17 Nov 2026. The order loop is built and tested (583 tests, including an end-to-end
test from signup to shipped). Tenant isolation is verified on the live Supabase project as `anon`.
What remains is almost entirely **configuration that only an account owner can do**, followed by
one supervised real order. This plan lists every step in order, who does it, and how to know it
worked. Each step has a check that names its own failure, so nothing has to be debugged blind.

## Where things stand

| Area | State |
|---|---|
| Code | Order loop, labels, Shopify, pricing/ledger, fulfillment, operator pages, email: done |
| CI on `main` | **Red** since `6c02e0a`: the README rewrite fails the format check. Fixed on `go-live` |
| Supabase `jjqxncbwfulwzraarvln` | 10 of 11 migrations applied (`0010` is on `go-live`); private bucket exists; **not seeded** (0 users) |
| Isolation | Live catalog audit + 125 live probes as `anon`: 0 leaks. Signed-in probes need a seeded user |
| Vercel | Deployed (URL known only to the owner). Not visible to this session's Vercel account |
| Job queue | **Never drained**: `APP_URL` / `CRON_SECRET` repository secrets are missing (every scheduled run fails and says so) |
| Email | Built; sends nothing until `RESEND_API_KEY` + `EMAIL_FROM` are set (emails queue, none lost) |
| Shopify | Adapter on API `2026-07`; never run against a real store |

## Phase A: unblock (owner, ~30 minutes, no code)

Do these in order. Each one ends with a check.

1. **Merge the `go-live` PR into `main`.** It turns CI green (README formatting) and carries
   migration `0010`, the queue fixes, preflight, the seed workflow and email.
   *Check:* the CI run on `main` passes.
2. **Add repository secrets** (GitHub → Settings → Secrets and variables → Actions):
   - `APP_URL`: the deployed origin, e.g. `https://<project>.vercel.app`
   - `CRON_SECRET`: exactly the value set in Vercel
   - `SEED_DATABASE_URL`: Supabase **session** pooler (port 5432) connection string
   - `SUPABASE_URL`: `https://jjqxncbwfulwzraarvln.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY`: from Supabase → Settings → API (server-only)
   - `SEED_DEMO_PASSWORD`: choose one, at least 10 characters
3. **Add Vercel env vars** for email, then redeploy: `RESEND_API_KEY` and `EMAIL_FROM`
   (a sender on a domain verified in Resend). Optional for go-live; without them email waits.
4. **Run "Migrate and seed (Supabase)"** (Actions → Run workflow). Applies `0010`, seeds the
   catalog, fee schedule, fulfillment center, partner SKU codes, placeholder label template, and
   creates `demo-owner@example.com` / `demo-admin@example.com` as real, confirmed Auth users.
   *Check:* the run is green; sign in to the deployed app as both accounts.
5. **Run "Preflight (deployed app)".** The deployed runtime checks itself: env, site URL vs the
   deployment's host, migrations, tenant isolation through the real connection, API-role lockout,
   bucket privacy, a storage round trip, auth, **label pixel hashes**, Shopify API version, seed
   data, queue health and email. Each check is an annotation; the run summary is a table.
   *Check:* "Preflight: ready". Any `fail` names the exact fix.
6. **Run "Drain job queue".** *Check:* the summary shows job counts (a 404 annotation means
   `CRON_SECRET` does not match Vercel).
7. **Signed-in isolation probes.** Add secrets `VERIFY_EMAIL=demo-owner@example.com` and
   `VERIFY_PASSWORD=<SEED_DEMO_PASSWORD>`, optionally `VERIFY_DATABASE_URL` (read-only is enough),
   then run "Verify isolation (live Supabase)" with the project URL and publishable key.
   *Check:* "0 leaks, 0 invalid" for roles `anon+authenticated`.
8. **Re-pause the unrelated SportFo Supabase project** (`emlxsgdrcbivcftbcddz`) if it should be
   paused; an earlier session restored it by mistake.

## Phase B: Shopify readiness (owner, ~20 minutes)

9. In the Partners dashboard for the app:
   - App URL `https://<app>`, redirect URL `https://<app>/api/integrations/shopify/callback`.
   - **Request protected customer data access** (order name, address, email). Without it Shopify
     refuses the order webhooks at connect time and order reads fail.
   - **Compliance webhooks:** set all three (customer data request, customer data erasure, shop
     data erasure) to `https://<app>/api/webhooks/shopify`. The app handles them (see Phase D1).
10. In Supabase Auth → URL configuration: Site URL = the deployed URL; add
    `https://<app>/auth/callback` as a redirect URL (email verification and password reset).

## Phase C: the first real order (owner drives the browser; ~45 minutes)

Run with Claude watching: give it the app URL and store name, and it can read the job queue,
order rows and audit log at each step through the read-only Supabase connection.

| # | Action (where) | Expected result | If not |
|---|---|---|---|
| 1 | Sign in as `demo-owner` → `/settings/stores` → connect `<store>.myshopify.com` | Status "Connected", order webhooks "Active" | Order webhooks "Not subscribed (… HTTP 403)" → protected data access (B9), then "Retry webhooks" |
| 2 | `/brand-products/<id>` → publish to the store | Product appears in Shopify admin with 2 mockup images | Preflight `storage.*`, then the job's `last_error` |
| 3 | Shopify admin → Orders → **Create order** with the published product and a real-looking address → **Collect payment → Mark as paid**. Do **not** check out with Bogus Gateway or test-mode payments: Shopify flags those `test: true`, and ingest ignores test orders by design (§9.5) | Within seconds `/orders` shows it `awaiting_payment`; owner gets "Order received" | `webhook_events` row with status `ignored` + reason `test_order` = wrong order type; no row = webhooks not subscribed (B9). The reconciler also picks orders up within 15 min |
| 4 | Sign in as `demo-admin` → `/admin/orders/<id>` → mark paid | Order → `submitted` | `job_queue` row `fulfillment.order_paid` |
| 5 | `/admin/dispatch` → create batch for the demo center → download CSV | One row per line, partner SKU, signed artwork link | Review item "missing partner SKU" (seed step A4) |
| 6 | Fill `status=Shipped`, carrier, tracking number in the CSV → import | Report shows 1 applied; order → `shipped`; owner gets "Order shipped" | The import report names unmatched or malformed rows |
| 7 | Shopify admin → the order | Fulfilled, with the tracking number | `/admin/review` item for the shipment (push blocked) |

Record anything that breaks. Each fix gets a regression test, and if only real infrastructure
could show it, the PR says so (the house rule since PR #5).

## Phase D: engineering backlog (after the first order; Claude can do all of it)

Ordered by risk to a paying customer, not by size.

1. ~~**Shopify compliance webhooks**~~ **Done** (`phase-d`): data requests produce an export the
   brand owner downloads from an email link; redactions scrub customer data, deferring orders
   still in transit. Remaining gap: dispatch CSV files already handed to the manufacturer keep
   addresses (they are the manufacturer's copy; lifecycle rules for our stored copies are D9).
2. **Product publish via GraphQL.** REST product endpoints are legacy, and newer public apps must
   use GraphQL. The adapter boundary makes this a contained change behind `CommerceProvider`.
3. ~~**Retry the webhook subscription after connect**~~ **Done** (`phase-d`): failures are
   recorded on the integration, retried with backoff, and shown on `/settings/stores` with a
   "Retry webhooks" button.
4. **Dead-letter visibility:** `dead` jobs and `failed` notifications appear in `/admin/review`
   (today only preflight reports them).
5. **Vector PDF/X output** with an OutputIntent, replacing the 300 dpi raster, before the first
   print run with a real manufacturer.
6. **Virus scanning** for uploads (currently a stub that never blocks).
7. **Real bottle photography** for mockups: data only (`mockup_spec.backgroundAssetId`).
8. **Live payments** (§10), unblocked when a §18 default is decided; `PaymentProvider` already
   has the seam.
9. **Retention for dispatch CSVs** in storage: delete our stored copy once a batch is completed
   and past the claims window, so redacted customers' addresses don't persist there.

## Decisions the owner still owns

- Which email domain and sender name brand owners see (A3).
- Whether to move to Vercel Pro (1-minute cron, longer functions) or keep the GitHub schedule.
  The queue no longer depends on it: work drains right after each request.
- The real manufacturer and its partner SKU codes (replaces the demo center's data).
