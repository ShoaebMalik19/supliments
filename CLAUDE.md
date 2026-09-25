# CLAUDE.md

Private-label supplement commerce platform. Multi-tenant SaaS: brand owners (orgs) sell our
catalog under their label; we route orders to manufacturers. Architecture is decided in
`docs/PLATFORM-DISCOVERY.md` — do not re-derive it; read only the section you need
(§6 schema, §7 tenancy, §16 scope, §17 roadmap).

## Stack (decided)

- Next.js 15 App Router + TypeScript strict. One deployable; admin lives at `/admin`.
- Supabase: Postgres, Auth, Storage. Vercel hosting.
- Drizzle ORM. Schema in `src/db/schema/*.ts`; migrations in `db/migrations`.
  Table DDL is generated (`npm run db:generate`); RLS, roles, triggers and
  functions are hand-written custom SQL migrations (`npm run db:custom -- --name=x`).
  CI fails if the TS schema and generated migrations drift.
- Job queue: `job_queue` table (attempts, backoff, `dead` = DLQ), drained by `/api/cron/jobs`
  (Vercel cron, `CRON_SECRET`). Enqueue in the same transaction as the state change.
- Vitest against a real Postgres (`DATABASE_URL`, default local `app_test`).

## Commands

`npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run db:migrate`
Tests need Postgres: `service postgresql start` locally; CI uses a service container.

## Module boundaries

`src/modules/<name>` — auth · tenancy · audit · jobs · catalog · assets · branding · integrations
· orders · fulfillment · billing · notifications · admin.

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
- RLS is ENABLED on every public table. `org_id` tables get
  `SELECT enable_tenant_rls('t', '<grants>')` in a custom migration: policy
  `org_id = current_org_id()` (unset GUC → zero rows). `tests/schema.test.ts` fails CI
  if a table lacks RLS or an org_id table lacks the policy.
- Not FORCED: the table-owner connection role is the privileged path (Supabase's
  `postgres` cannot create BYPASSRLS roles). `app_user` is NOLOGIN, non-owner, no bypass.
- `anon`/`authenticated` get no grants on `public`. Child tables carry their own `org_id`.
- `src/db/privileged.ts` (bypasses RLS) may only be imported by modules auth, tenancy, admin,
  jobs, audit, `catalog/admin.ts` (catalog writes) and tests (ESLint). Every privileged
  cross-tenant action writes an AuditLog row.
- Cross-tenant access returns **404, never 403**. Every tenant API route is registered in
  `tests/cross-tenant/routes.ts` (meta-test enforces; routes without a per-row target go in
  `unscopedTenantRoutes` with their own check). Every `src/app/api/admin` route uses
  `adminRoute` and is in `tests/admin-routes.ts`; non-admins (even org owners) get 404.

## Money rule (non-negotiable)

- Integer minor units (`bigint`, column suffix `_minor`) + ISO-4217 `currency`
  (`char(3)`, uppercase check) on every amount. Never floats, never `numeric` money.
- `tests/schema.test.ts` fails on a `*_minor` column without currency or any float column.
- TS: `Money = { amountMinor: bigint; currency: string }` (`src/lib/money.ts`). Wire: output
  digit strings (`json()`); input a safe integer or digit string (`minorUnitsInput`), never
  decimals. An amount is only written together with its currency.

## Adapter rule

- Every external vendor (Supabase Auth/Storage, Shopify, payment, manufacturer, email,
  carrier) is called only from `src/adapters/<vendor>/`, behind an interface owned by the
  consuming module (`AuthProvider`, `StorageProvider`, …). Modules never import vendor SDKs.
- The spreadsheet fulfillment adapter lives in `src/adapters/manual`; nothing outside
  it may know about columns, filenames or email (§0.1).
- `PaymentProvider`: only `manual` in v1; charges are `pending_external` rows + ledger.

## Data conventions

- UUID v7 PKs via SQL `uuid_generate_v7()`. `created_at`/`updated_at` timestamptz.
- Append-only tables (audit_logs, order_events, ledger_entries, wallet_transactions,
  inventory_ledger) have a trigger rejecting UPDATE/DELETE.
- `users.id` = Supabase `auth.users.id` (no FK: schema must run on plain Postgres).
- Roles: owner · admin · member · designer · read_only. Platform admins: `platform_admins`.

## Choices made where the brief was ambiguous

- Org provisioned at signup (before email verification) with the signer as owner.
- `dispatch_batches`, `inventory`, `webhook_events`, catalog tables are platform-owned
  (no `org_id`, no tenant grants except read-only catalog).
- `job_queue`/`outbox_events` carry nullable `org_id`; tenants may only insert.
- Payment/charge status adds `pending_external` (§0.1).
- Assets: one private bucket (`ASSETS_BUCKET`), signed URLs only (download TTL 60s). Keys are
  server-generated `org/{orgId}/{assetId}/{random}` (DB check; platform: `platform/...`).
  `upload_status` pending → ready | rejected (terminal); ready only after magic bytes + exact
  size match. Tenants may UPDATE only upload_status/width/height/checksum. Virus scan: stub.

## Order loop (MVP) — contracts shared across modules

- `modules/pricing/calc.ts`: pure money maths. `FeeRules` = `fee_schedules.rules` (per-order +
  per-unit fulfillment fee, first/additional-unit shipping, markup bps rounded half-up). In force =
  highest version whose [effective_from, effective_to) contains the time. No FX: product, SKU and
  schedule currencies must match. Margin = retail − 1-unit order cost; negatives shown, not blocked.
- `modules/orders/external.ts`: `ExternalOrder`, the only order shape adapters hand to orders.
- `modules/integrations/provider.ts`: `CommerceProvider` (Shopify is one implementation).
- Server-rendered assets via `storeGeneratedAsset` (ready on creation, checksum stored).

### Labels (M2)

- `labels` owns labels + label_templates. Templates are DATA (`db/seed/label-templates/*.json`,
  `loadLabelTemplate`); label geometry in code is a bug. The placeholder is `is_placeholder`.
- One renderer (`labels/render.ts`) for preview PNG, print PDF (MediaBox=BleedBox, TrimBox inset)
  and mockups; outputs go through `storeGeneratedAsset` under the label's org.
- Only drafts edit in place; other edits create version max+1. Approval freezes PDF + mockups and
  supersedes the previous approved version. Publishing/orders use `getApprovedLabel()`.
- Tenants may INSERT open review items; closing is privileged (`admin.closeReviewItem`).

### Shopify (M3)

- Only `src/adapters/shopify` knows Shopify URLs/fields; money is decimal strings parsed as strings.
  `integrations/privileged.ts` is the only RLS-bypassing integrations code (routing by shop,
  hijack detection, reconcile scheduling). Tokens: AES-256-GCM (`INTEGRATION_ENCRYPTION_KEY`, id
  `v1`), decrypted only in `integrations/connection.ts`; never in responses, audit, jobs or logs.
- Webhooks: HMAC over raw body → persist + enqueue → 200. The HMAC does not cover the shop header,
  so order webhooks are notifications only: the job re-fetches the order from the integration's
  own shop (`fetchOrder`) and ignores it if absent. Reconciler polls every 15 min with overlap.
- Store pushes go through `pushShipmentToStore`/jobs; 401 → `needs_reauth`, pushes halt.

### Orders, pricing, ledger (M4)

- Order status changes only via `orders/state.ts` `transitionOrder` (row lock, order_event,
  outbox row); `ORDER_TRANSITIONS` is the table. Cancel only before `submitted`; terminal states
  have no exits. Ingest on `paid`; test orders ignored; non-catalog lines skipped, our-but-unmapped
  lines → `needs_review`. Lines resolve by sync mapping (variant id), then SKU — never title.
- One Charge per order (`pending_external`, key `order:{id}`); ledger lines sum to the charge;
  the manual payment line is negative so a paid order nets to 0. `PaymentProvider` = `manual`.
- A paid order stays `awaiting_payment` until fulfillment moves it to `submitted`
  (job `fulfillment.order_paid`). Admin order actions resolve org privileged, then `withTenant`.

## Working rules

- No comments that restate code. No UI component library yet. Commit per logical step.
  Tests for isolation and constraints, not trivial code.
