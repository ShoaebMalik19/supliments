# Private-label supplement platform

Multi-tenant SaaS: brand owners put our catalog products under their own label, sell them on
their Shopify store, and we route each order to a manufacturer. Architecture and rules live in
[`CLAUDE.md`](CLAUDE.md) and [`docs/PLATFORM-DISCOVERY.md`](docs/PLATFORM-DISCOVERY.md).

## What works end to end

`tests/e2e/order-loop.test.ts` drives the whole MVP loop through the real route handlers and a
real Postgres (only the session, object storage and Shopify's HTTP API are faked):

signup → create brand → pick a catalog product → upload logo → design a label on a template →
submit → admin approves → print-ready PDF + mockups → publish to a connected Shopify store →
order webhook → line resolves to a SKU → priced from the versioned fee schedule → Charge +
ledger rows → admin marks paid → dispatch batch → CSV exported → completed CSV re-imported with
tracking → fulfillment + tracking pushed to Shopify → order timeline shows shipped.

## Run the tests locally

Requirements: Node 22, PostgreSQL 16 on `localhost:5432` with user `postgres` / password
`postgres` (any superuser works; set `DATABASE_URL` otherwise).

```bash
npm ci
createdb -h localhost -U postgres app_test      # once; tests drop and re-migrate its schema
npm test                                        # all unit, isolation and E2E tests
npm run test:e2e                                # only the end-to-end order loop
npm run typecheck && npm run lint && npm run build
```

No Postgres installed? `docker run -d --name pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app_test -p 5432:5432 postgres:16`.

## Seed demo data

```bash
createdb -h localhost -U postgres app_dev
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/app_dev
npm run db:migrate
npm run db:seed
```

The seed is idempotent. It creates:

- **Platform data:** a fee schedule; a manufacturer and fulfillment center using the spreadsheet adapter; the **placeholder** 60-capsule label template (loaded from `db/seed/label-templates/placeholder-60ct-bottle.json`); and one active `on_demand` catalog product with two SKUs and partner SKU codes.
- **Demo data:** an org ("Demo Supplements Co.") with a brand, a brand product, an approved label (real PDF and mockups rendered to `.data/storage/`), and a paid sample order awaiting payment confirmation.

With `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SEED_DEMO_PASSWORD` set, the demo accounts are real, email-confirmed Supabase users you can sign in as: `demo-owner@example.com` (brand owner) and `demo-admin@example.com` (platform admin), both with `SEED_DEMO_PASSWORD`. Without those variables the demo users are local-only and cannot sign in.

## Run the app

The app needs a Supabase project for Auth and Storage:

- Hosted: create one at supabase.com.
- Local: run `npx supabase start`, which needs Docker.

1. `cp .env.example .env.local` and fill it in:
   - `DATABASE_URL` is the project's Postgres. On hosted Supabase, use the transaction pooler.
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` come from the Supabase project.
   - `ASSETS_BUCKET` names a **private** Storage bucket. Create it in the dashboard.
   - `INTEGRATION_ENCRYPTION_KEY`: generate with `openssl rand -base64 32`.
   - `CRON_SECRET`: any long random string.
   - `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` come from a Shopify Partners app. Set its redirect URL to `$NEXT_PUBLIC_SITE_URL/api/integrations/shopify/callback`.
2. `npm run db:migrate && npm run db:seed` (seeding is optional, but gives you a catalog).
3. `npm run dev`, open http://localhost:3000, and sign up. Verify the email, then log in.
4. Make yourself a platform admin:
   `insert into platform_admins (user_id) select id from users where email = 'you@example.com';`
5. Background jobs (publish, webhook processing, fulfillment, store pushes, the stuck-order
   monitor) run when the cron route is called. Vercel calls it every minute. Locally:
   `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/jobs`.

Plain pages:

- **Brand side:** `/catalog`, `/brand-products/[id]`, `/labels/[id]`, `/orders`, `/orders/[id]`.
- **Admin:** `/admin`, `/admin/catalog`, `/admin/labels`, `/admin/orders/[id]`, `/admin/dispatch`.

## Layout

| Path                 | What                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/modules/*`      | Business modules (tenancy, branding, labels, integrations, orders, billing, fulfillment, …)                     |
| `src/adapters/*`     | The only code that talks to vendors: `supabase`, `shopify`, `manual` (spreadsheet fulfillment, manual payments) |
| `src/app`            | Thin routes and pages                                                                                           |
| `db/migrations`      | Drizzle-generated DDL + hand-written RLS/trigger migrations                                                     |
| `tests/cross-tenant` | Permanent isolation suite: every tenant route must be registered                                                |

## Deploy (Supabase + Vercel + Shopify)

Each step needs an account owner's access. In order:

1. **Supabase:** create a project for this app. Don't reuse an unrelated project: migration `0002` revokes Data API grants on the whole `public` schema, which would break another app sharing it.
   - Create a **private** Storage bucket named after `ASSETS_BUCKET`.
   - Set Auth → URL configuration → Site URL to the deployed URL, and add `https://<app>/auth/callback` as a redirect URL.
2. **Migrate and seed** from a machine that can reach the database. Use the _session_ pooler (port 5432) or the direct connection for migrations:
   ```bash
   DATABASE_URL=<session or direct url> npm run db:migrate
   DATABASE_URL=<…> NEXT_PUBLIC_SUPABASE_URL=<…> SUPABASE_SERVICE_ROLE_KEY=<…> \
     SEED_DEMO_PASSWORD=<choose one> ASSETS_BUCKET=<…> npm run db:seed
   ```
   The seed writes rendered files to local disk (`.data/storage`), not to Supabase Storage, so the demo label's images aren't viewable in the deployed app. Labels made through the app are stored in Supabase Storage.
3. **Vercel:** import the GitHub repo, framework Next.js. Set every variable in `.env.example`:
   - `DATABASE_URL` must be the _transaction_ pooler (port 6543).
   - `NEXT_PUBLIC_SITE_URL` is the deployed URL.
   - `CRON_SECRET` must be set: Vercel sends it as `Authorization: Bearer` to `/api/cron/jobs`.
   - **Cron:** `vercel.json` runs the job drain every minute, which needs a Pro plan. Hobby only allows daily crons: the deploy is rejected or jobs drain once a day. On Hobby, call `/api/cron/jobs` from an external scheduler instead (for example, a GitHub Actions `schedule:` workflow running `curl` with the bearer secret).
4. **Verify the deployment:**
   - `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/jobs` returns job counts.
   - As a platform admin, `GET /api/admin/diagnostics/render` must return the pixel hashes pinned in `tests/golden-render.test.ts`.
5. **Shopify:** create a Partners app.
   - App URL: `https://<app>`. Redirect URL: `https://<app>/api/integrations/shopify/callback`.
   - Put its key and secret in Vercel and redeploy.
   - Create a development store. Then, in the app: `/settings/stores` → connect → publish a product → place a test order in the store → `/admin/orders/<id>` mark paid → `/admin/dispatch` create batch → download → fill in tracking → import. Tracking should appear on the order in the Shopify admin.
