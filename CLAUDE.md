# CLAUDE.md

Private-label supplement commerce platform. Multi-tenant SaaS: brand owners (orgs)
sell our catalog under their label; we route orders to manufacturers.
Architecture is decided in `docs/PLATFORM-DISCOVERY.md` — do not re-derive it.
Read only the section you need (§6 schema, §7 tenancy, §16 scope, §17 roadmap).

## Stack (decided)

- Next.js 15 App Router + TypeScript strict. One deployable; admin lives at `/admin`.
- Supabase: Postgres, Auth, Storage. Vercel hosting.
- Drizzle ORM. Schema in `src/db/schema/*.ts`; migrations in `db/migrations`.
  Table DDL is generated (`npm run db:generate`); RLS, roles, triggers and
  functions are hand-written custom SQL migrations (`npm run db:custom -- --name=x`).
  CI fails if the TS schema and generated migrations drift.
- Job queue: `job_queue` table (attempts, backoff, `dead` = DLQ), drained by
  `/api/cron/jobs` (Vercel cron, `CRON_SECRET`). No external queue vendor.
  Enqueue inside the same transaction as the state change (outbox semantics).
- Vitest against a real Postgres (`DATABASE_URL`, default local `app_test`).

## Commands

`npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run db:migrate`
Tests need Postgres: `service postgresql start` locally; CI uses a service container.

## Module boundaries

`src/modules/<name>` — auth · tenancy · audit · jobs · catalog · branding ·
integrations · orders · fulfillment · billing · notifications · admin.

- A module only reads/writes its own tables. Cross-module access goes through
  the other module's exported functions (`src/modules/<name>/index.ts`).
- `src/app` (routes/pages) is thin: resolve context, call a module, map to HTTP.
- `src/db/schema` is shared type definitions only — no logic.

## Tenancy rule (non-negotiable)

- `org_id` is resolved server-side: auth user → membership → org. Never taken from
  body, URL or header. Active org may be _selected_ by cookie only when the value
  matches one of the user's memberships (validated server-side).
- Tenant data is accessed only via `withTenant(orgId, fn)` (`src/db/tenant.ts`):
  it opens a transaction, `SET LOCAL ROLE app_user`, sets `app.current_org`, and
  hands out a `TenantDb` that injects `org_id` on insert and filters by it on read.
- RLS is ENABLED on every public table. Tables with `org_id` get
  `SELECT enable_tenant_rls('table', '<grants>')` in a custom migration: policy
  `org_id = current_org_id()` (= `nullif(current_setting('app.current_org', true), '')::uuid`;
  missing-ok so an unset GUC yields zero rows) for `app_user`, plus grants.
  `tests/schema.test.ts` fails CI if a table lacks RLS or an org_id table lacks the policy.
- Not FORCED: the table-owner connection role is the privileged path (Supabase's
  `postgres` cannot create BYPASSRLS roles). `app_user` is NOLOGIN, non-owner, no bypass.
- Supabase `anon`/`authenticated` get no grants on `public` (no PostgREST exposure).
- Child tables carry their own denormalized `org_id` so RLS never needs joins.
- `src/db/privileged.ts` (bypasses RLS) may only be imported by `modules/auth`,
  `modules/tenancy`, `modules/admin`, `modules/jobs`, `modules/audit`, and tests
  (ESLint `no-restricted-imports`).
  Every privileged cross-tenant action writes an AuditLog row.
- Cross-tenant access returns **404, never 403**. Every route touching tenant data
  must be registered in `tests/cross-tenant/routes.ts`; a meta-test fails if an
  API route file uses `withTenant` and is not registered. Extend this suite forever.

## Money rule (non-negotiable)

- Integer minor units (`bigint`, column suffix `_minor`) + ISO-4217 `currency`
  (`char(3)`, uppercase check) on every amount. Never floats, never `numeric` money.
- `tests/schema.test.ts` fails if any `*_minor` column lacks a currency column in
  its table, or if any `real`/`double precision` column exists.
- In TS use `Money = { amountMinor: bigint; currency: string }` (`src/lib/money.ts`).

## Adapter rule

- Every external vendor (Supabase Auth/Storage, Shopify, payment, manufacturer,
  email, carrier) is called only from `src/adapters/<vendor>/`, behind an interface
  owned by the consuming module (e.g. `AuthProvider`, `FulfillmentProvider`,
  `PaymentProvider`). Modules never import vendor SDKs directly.
- The spreadsheet fulfillment adapter lives in `src/adapters/manual`; nothing outside
  it may know about columns, filenames or email (§0.1).
- `PaymentProvider` has only a `manual` implementation in v1; charges are
  `pending_external` rows + ledger entries.

## Data conventions

- UUID v7 PKs via SQL `uuid_generate_v7()`. `created_at`/`updated_at` timestamptz.
- Append-only tables (audit_logs, order_events, ledger_entries, wallet_transactions,
  inventory_ledger) have a trigger rejecting UPDATE/DELETE.
- `users.id` = Supabase `auth.users.id` (no FK: schema must run on plain Postgres).
- Platform admins: `platform_admins` table, independent of org roles.
- Roles: owner · admin · member · designer · read_only.

## Choices made where the brief was ambiguous

- Org provisioned at signup (before email verification) with the signer as owner.
- `dispatch_batches`, `inventory`, `webhook_events`, catalog tables are platform-owned
  (no `org_id`, no tenant grants except read-only catalog).
- `job_queue`/`outbox_events` carry nullable `org_id`; tenants may only insert.
- Payment/charge status adds `pending_external` (§0.1).

## Working rules

- No comments that restate code. No UI component library yet.
- Commit per logical step. Tests for isolation and constraints, not trivial code.
