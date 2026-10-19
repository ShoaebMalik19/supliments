<div align="center">

# Private-Label Supplement Platform

**Multi-tenant SaaS that lets brands sell catalog supplements under their own label on Shopify, with orders routed to the manufacturer.**

[![Next.js](https://img.shields.io/badge/Next.js_15-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-1e3a5f?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-1c1c1c?style=for-the-badge&logo=supabase&logoColor=3ECF8E)](https://supabase.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL_16-1f2d3d?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Drizzle](https://img.shields.io/badge/Drizzle_ORM-1a1a1a?style=for-the-badge&logo=drizzle&logoColor=C5F74F)](https://orm.drizzle.team)
[![Shopify](https://img.shields.io/badge/Shopify_API-1a2e1a?style=for-the-badge&logo=shopify&logoColor=95BF47)](https://shopify.dev)
[![Vitest](https://img.shields.io/badge/Vitest-1a1a1a?style=for-the-badge&logo=vitest&logoColor=FCC72B)](https://vitest.dev)
[![Live Demo](https://img.shields.io/badge/Live_Demo-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://supliments-lemon.vercel.app)

</div>

---

## ✨ Overview

Brand owners pick products from a shared supplement catalog, design a label on a print template, and publish the product to their own Shopify store. When a consumer orders, the platform ingests the Shopify webhook, resolves the line to a SKU, prices it from a versioned fee schedule, charges the brand, dispatches the order to the manufacturer and pushes fulfillment and tracking back to Shopify.

The platform never touches the end consumer's money: the brand's store collects retail payment, and the platform bills the brand for product, fulfillment and shipping. Architecture and design decisions live in [`docs/PLATFORM-DISCOVERY.md`](docs/PLATFORM-DISCOVERY.md) and [`CLAUDE.md`](CLAUDE.md).

### The MVP loop, end to end

`tests/e2e/order-loop.test.ts` drives the whole loop through the real route handlers and a real Postgres (only the session, object storage and Shopify's HTTP API are faked):

```
signup → create brand → pick a catalog product → upload logo → design a label on a template
→ submit → admin approves → print-ready PDF + mockups → publish to a connected Shopify store
→ order webhook → line resolves to a SKU → priced from the versioned fee schedule
→ charge + ledger rows → admin marks paid → dispatch batch → CSV exported
→ completed CSV re-imported with tracking → fulfillment + tracking pushed to Shopify
→ order timeline shows shipped
```

## 🚀 Features

- **Multi-tenancy with Postgres RLS:** every public table has row-level security, tenant data is only reachable through `withTenant(orgId, fn)`, and cross-tenant access returns 404. A permanent isolation suite enforces that every tenant route is registered and checked.
- **Label designer and renderer:** templates, brand logo uploads, and server-side rendering of print-ready PDFs and mockups (`pdf-lib`, `opentype.js`, `sharp`), covered by golden pixel-hash tests.
- **Admin review workflow:** approve or reject labels, manage the catalog, SKUs, costs and fee schedules, and resolve orders.
- **Shopify integration:** OAuth install, encrypted integration secrets, product publishing, order webhooks, and fulfillment/tracking push-back.
- **Pricing and billing:** versioned fee schedules, per-order charges and ledger rows, manual payment confirmation.
- **Spreadsheet fulfillment adapter:** dispatch batches exported as CSV and re-imported with tracking, behind a `FulfillmentProvider` interface so a manufacturer API can be added later without touching the order module.
- **Job queue with retries:** a `job_queue` table with attempts, backoff and a dead-letter state, drained by a cron route.
- **Strict CI:** typecheck, lint, tests against a real Postgres, and a drift check between the TypeScript schema and generated migrations.

## 🧱 Tech Stack

| Layer | Tools |
| --- | --- |
| App | Next.js 15 (App Router), React 19, TypeScript (strict) |
| Data | PostgreSQL, Drizzle ORM + drizzle-kit, hand-written RLS/trigger migrations |
| Auth & storage | Supabase Auth and Storage (`@supabase/ssr`, `@supabase/supabase-js`) |
| Rendering | `pdf-lib`, `opentype.js`, `sharp` |
| Validation | Zod |
| Testing | Vitest (unit, cross-tenant isolation, E2E) |
| Hosting & jobs | Vercel, GitHub Actions scheduled workflow |

## 🗂️ Project Structure

```
.
├── src/
│   ├── app/            # Thin routes and pages (brand side + /admin)
│   ├── modules/        # Business modules: tenancy, branding, labels, integrations,
│   │                   # orders, billing, fulfillment, pricing, jobs, admin, ...
│   ├── adapters/       # Only code that talks to vendors: supabase, shopify, manual
│   └── db/             # Drizzle schema, tenant and privileged DB access
├── db/
│   ├── migrations/     # Generated DDL + hand-written RLS/trigger migrations
│   └── seed/           # Label template seed data
├── scripts/            # migrate, seed, seed-label-templates
├── tests/              # Unit, cross-tenant isolation and E2E suites
├── docs/               # Platform discovery and architecture
└── .github/workflows/  # CI and the job-queue cron
```

## ⚡ Getting Started

### Prerequisites

- Node.js 22+
- PostgreSQL 16 (local or Docker)
- A Supabase project (hosted, or local via `npx supabase start`) for Auth and Storage

No Postgres installed?

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app_test -p 5432:5432 postgres:16
```

### Run the tests

```bash
npm ci
createdb -h localhost -U postgres app_test      # once; tests drop and re-migrate its schema
npm test                                        # unit, isolation and E2E tests
npm run test:e2e                                # only the end-to-end order loop
npm run typecheck && npm run lint && npm run build
```

### Run the app

1. Copy the env template and fill it in:

   ```bash
   cp .env.example .env.local
   ```

   | Variable | Purpose |
   | --- | --- |
   | `DATABASE_URL` | Postgres connection (transaction pooler on hosted Supabase) |
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project credentials |
   | `NEXT_PUBLIC_SITE_URL` | Public URL of the app |
   | `ASSETS_BUCKET` | Name of a **private** Supabase Storage bucket |
   | `INTEGRATION_ENCRYPTION_KEY` | Generate with `openssl rand -base64 32` |
   | `CRON_SECRET` | Any long random string |
   | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES` | From a Shopify Partners app (redirect URL: `$NEXT_PUBLIC_SITE_URL/api/integrations/shopify/callback`) |
   | `SEED_DEMO_PASSWORD` | Optional; makes the seeded demo users real Supabase accounts |

2. Migrate and (optionally) seed:

   ```bash
   npm run db:migrate && npm run db:seed
   ```

3. Start the dev server, open http://localhost:3000, sign up and verify your email:

   ```bash
   npm run dev
   ```

4. Make yourself a platform admin:

   ```sql
   insert into platform_admins (user_id) select id from users where email = 'you@example.com';
   ```

5. Background jobs (publish, webhook processing, fulfillment, store pushes, stuck-order monitor) run when the cron route is called:

   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/jobs
   ```

### Seed data

The seed is idempotent. It creates a fee schedule, a manufacturer and fulfillment center using the spreadsheet adapter, a placeholder 60-capsule label template, an `on_demand` catalog product with two SKUs, and a demo org ("Demo Supplements Co.") with an approved label and a sample order. With the Supabase variables and `SEED_DEMO_PASSWORD` set, you can sign in as `demo-owner@example.com` (brand owner) or `demo-admin@example.com` (platform admin).

### Pages

- **Brand side:** `/catalog`, `/brand-products/[id]`, `/labels/[id]`, `/orders`, `/orders/[id]`, `/settings/stores`
- **Admin:** `/admin`, `/admin/catalog`, `/admin/labels`, `/admin/orders/[id]`, `/admin/dispatch`

### Deploy (Supabase + Vercel + Shopify)

1. **Supabase:** create a dedicated project (migration `0002` revokes Data API grants on the whole `public` schema). Create a private Storage bucket named after `ASSETS_BUCKET`, set the Auth Site URL, and add `https://<app>/auth/callback` as a redirect URL.
2. **Migrate and seed** using the session pooler (port 5432) or a direct connection.
3. **Vercel:** import the repo and set every variable from `.env.example`. `DATABASE_URL` must use the transaction pooler (port 6543).
4. **Cron:** Vercel Hobby only allows daily cron, so `vercel.json` keeps a daily safety net and [`.github/workflows/cron.yml`](.github/workflows/cron.yml) calls `/api/cron/jobs` every 5 minutes. It needs the repository secrets `APP_URL` and `CRON_SECRET`.
5. **Verify:** the cron route returns job counts, and `GET /api/admin/diagnostics/render` (as an admin) returns the pixel hashes pinned in `tests/golden-render.test.ts`.
6. **Shopify:** create a Partners app with App URL `https://<app>` and redirect URL `https://<app>/api/integrations/shopify/callback`, then connect a development store from `/settings/stores` and run a test order through to tracking.

## 🛣️ Roadmap

- Manufacturer API fulfillment adapter alongside the current spreadsheet adapter (deferred until a manufacturer is signed, per [`docs/PLATFORM-DISCOVERY.md`](docs/PLATFORM-DISCOVERY.md)).

## 👤 Author

**Mohammed Shoaeb Malik** · AI & Full-Stack Developer, Bengaluru

[![GitHub](https://img.shields.io/badge/GitHub-ShoaebMalik19-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/ShoaebMalik19)
