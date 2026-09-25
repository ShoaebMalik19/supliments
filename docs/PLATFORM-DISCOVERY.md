# Private-Label Commerce Platform — Discovery & Architecture

**Status:** pre-development discovery. No code is to be written from this document until Section 18 questions are answered.
**Audience:** two founders — one commercial (marketing, sales, finance, supplier relationships), one technical (architecture through deployment).
**Convention:** anything that cannot be derived from the stated business concept is marked `founder input needed`. There are 47 of them. That count is the real output of this document.

---

## 0. The one thing to understand before anything else

In this business model **the platform never touches the end consumer's money.**

The brand owner's store (Shopify, etc.) collects the retail payment from the consumer. Our platform then charges *the brand owner* for the product cost + fulfillment + shipping, and the brand owner keeps the difference as margin. The consumer is not our customer, legally or financially. They are our customer's customer.

Every architectural decision downstream follows from this. It means:

- We are a **B2B SaaS + wholesale fulfillment** business, not a marketplace and not a payment facilitator.
- We do not need marketplace-style split payments, KYC of sellers for payouts, or money-transmission licensing (we are not moving money on someone else's behalf).
- We **do** need a reliable way to charge brand owners *per order, automatically, and possibly before we incur cost* — because if a brand's card declines after we've manufactured and shipped, we've eaten the cost.
- Our credit risk is concentrated in the gap between "we fulfill" and "brand pays."

If the business intends a different model (platform hosts the storefront and collects consumer payment directly), stop and say so now — it changes roughly 40% of this document.

*Founder input, default taken in §18:* Is the platform ever the merchant of record for the end consumer? (Assumed: **no**.)

---

## 0.1 Scope decisions — 25 Sep 2026

Two capabilities are **deferred by founder decision**, with the explicit requirement that the foundation supports them later without rework. This is a sequencing change, not a scope cut.

### Deferred: manufacturer API automation

No manufacturer is signed yet, so there is nothing to integrate against. **Version 1 dispatches orders to the manufacturer as a spreadsheet** (CSV/XLSX export, emailed or uploaded), and status/tracking comes back the same way.

What this changes: nothing structural. The `FulfillmentProvider` interface, the canonical order model, `FulfillmentOrder`, idempotency keys, status normalization and reconciliation all get built now — the spreadsheet export *is* an adapter implementing that interface, not a shortcut around it. When a manufacturer with an API appears, we write a second adapter and change one configuration row on the fulfillment centre. No order-module code changes.

What we must not do: let "it is just a spreadsheet" leak into the order module. If any code outside `adapters/manual` knows about columns, filenames or email, the abstraction has already failed and the later migration becomes a rewrite.

Required now, and cheap: stable SKU codes, `PartnerSkuMapping`, per-order idempotency keys recorded **before** export, a `DispatchBatch` record so every exported row is traceable to a batch and back to an order, and an import path for the returned sheet that is idempotent on our order reference.

### Deferred: live payment processing

No payment provider is integrated in v1. Brand owners are onboarded manually and billed outside the system (a §18 default stays open).

What gets built now is the **pricing and ledger layer**, which is the part that is expensive to retrofit. Every order is priced server-side from the versioned fee schedule and written as `Charge` rows in state `pending_external` against an internal ledger, so cost of goods, fulfillment fee, shipping and platform markup are recorded per order from day one. What is *not* built is the provider call — `PaymentProvider` has one implementation, `manual`, which records an ops-marked payment instead of moving money.

One consequence to accept deliberately: **there is no automatic payment gate before fulfillment in v1.** In the target design, production is blocked until the brand's charge succeeds. Until a processor is live, that control is a human check on a work queue. Keep the `awaiting_payment` state in the machine from the beginning — the state exists, only its exit trigger is manual — so switching to automatic gating later is a change of trigger, not a change of model.

### Foundation requirements this imposes

| Build now | Defer |
|---|---|
| `FulfillmentProvider` interface + canonical order model | Any partner's REST client |
| Spreadsheet adapter behind that interface | Partner webhooks, live inventory feeds |
| Idempotency keys, dispatch batches, reconciliation | Automatic resubmission on partner timeout |
| Order state machine incl. `awaiting_payment`, `submitted`, `shipped` | Automatic payment gating |
| Versioned fee schedule + server-side pricing + ledger | Provider integration, dunning, SCA |
| `PaymentProvider` interface with a `manual` implementation | Subscriptions, wallets, invoices as code |
| Money as integer minor units + currency everywhere | Multi-currency, FX, tax engines |

The rest of this document describes the target system. Sections 10 and 11 remain the design we are building *toward*; Sections 16 and 17 reflect the deferral.

---

## 1. BUSINESS MODEL — end-to-end narrative

### 1.1 User signup
A prospective brand owner signs up with email/password or OAuth. They land in an onboarding flow that collects: name, country, intended niche, whether they already have a store. Account is created with an **Organization** (the tenant) even for a solo user — never attach data directly to a user.

Gating decisions:
- Is the catalog visible before signup? (SEO argument for yes, competitive-secrecy argument for no.)
- Is there a paid plan required before seeing wholesale prices? Supliful shows products free and gates *label customization and publishing* behind a subscription.

*Founder input, default taken in §18:* Is catalog + wholesale pricing public, gated behind signup, or gated behind payment?
*Founder input, default taken in §18:* Is there a free tier, and what exactly does it withhold?

### 1.2 Brand creation
The user creates a Brand: name, logo, brand colors, optional brand story, contact email for customer-facing communication, return address preference. A Brand is the unit that labels and stores attach to.

Important early decision: **one org : many brands?** A supplement entrepreneur running three niches (gym, sleep, pets) wants three brands, three Shopify stores, one login, one invoice. Building this as `Organization 1—* Brand` from day one costs almost nothing; retrofitting it later is painful.

*Founder input, default taken in §18:* Are multiple brands per account allowed on the entry plan, or is that an upsell?

### 1.3 Product selection
The brand owner browses our catalog of base products supplied by manufacturers: e.g. "Ashwagandha 600mg, 60 capsules, white HDPE bottle, 100ml." Each catalog entry exposes:
product name, category, ingredients/spec sheet, base cost to brand, MSRP suggestion, shipping weight/dimensions, label template dimensions & print spec, lead time, fulfillment regions, MOQ (usually 1 for true dropship), certifications, compliance documents.

They "add to my brand," which creates a **BrandProduct** — the brand's instance of a catalog product, carrying their label, their retail price, and their storefront linkage. The catalog product is ours; the BrandProduct is theirs. This distinction is the backbone of the data model.

### 1.4 Product customization
The brand owner produces a label: upload a logo, choose a template, edit text fields (product name, flavor, claims text, supplement facts panel — usually fixed by the manufacturer and *not* editable), pick colors, position artwork inside a print-safe area with bleed and margins. They see a live 2D flat preview and a 3D/photographic mockup of the bottle.

Then: **design review**. Someone (us, or the manufacturer's prepress team) must approve that the file is printable and legally non-insane before it goes to production. Auto-approval is a business risk; manual approval is an operations cost.

*Founder input, default taken in §18:* Is label approval automated, manual by us, or manual by the manufacturer? What is the SLA?
*Founder input, default taken in §18:* Who is contractually responsible if a label makes a non-compliant health claim — us or the brand owner? (Affects whether we need a review queue at all, and what the ToS must say.)

### 1.5 Pricing
The brand owner sets a retail price per product. We show base cost, estimated fulfillment fee, estimated shipping, and computed margin. We should warn on below-cost pricing but probably not block it.

*Founder input, default taken in §18:* Do we enforce a minimum retail price (MAP policy) to stop brands racing to the bottom and devaluing the catalog?

### 1.6 Product publishing
On publish, we push the product to the brand's connected store: title, description, images (their mockups), price, SKU, weight, and inventory policy. We store the mapping between our BrandProduct and the external store's product/variant IDs. This mapping is the single most important integration record in the system — without it, incoming orders cannot be resolved to a manufacturable SKU.

### 1.7 Customer purchase & payment
A consumer buys on the brand's store. The brand's own payment processor (Shopify Payments/Stripe/PayPal) charges the consumer. Money lands in the **brand owner's** bank account. We see none of it. We learn about the order via webhook.

### 1.8 Order creation (on our side)
The store fires an `orders/create` (or paid) webhook. We verify the signature, deduplicate, resolve each line item to a BrandProduct → SKU, validate the shipping address, price the order (product cost + fulfillment + shipping), and place a charge or authorization against the brand owner's payment method — or debit their prepaid wallet balance.

*Founder input, default taken in §18:* Charge model — (a) charge the brand's card per order at import, (b) prepaid wallet the order debits, (c) invoice weekly/monthly on credit terms. This single choice determines our cash-flow risk, our Stripe integration shape, and our dunning logic.

### 1.9 Fulfillment
Once paid, we create a fulfillment order at the manufacturer/3PL via their API (or CSV/SFTP/email for unsophisticated partners — plan for this, it is the common case). We send: items + quantities, the approved label artwork reference, destination address, service level, and our order reference.

### 1.10 Manufacturing
For true on-demand private label, the partner holds **bulk unlabeled stock** and applies the brand's label at pick time. This is the only way single-unit orders are economic. Some products instead require a production run against MOQ, with the brand owner pre-buying inventory that we then store and dropship.

These are two genuinely different product modes and the catalog must model both:
- **on_demand** — label-at-pick, no brand-owned inventory, unit cost higher.
- **stocked / pre_purchased** — brand buys a run, we hold labeled inventory, unit cost lower, brand carries inventory risk.

*Founder input, default taken in §18:* Does the MVP support only on-demand, or both modes?

### 1.11 Shipping
The partner buys a label from a carrier and ships to the consumer under the brand's name (branded packing slip, no platform branding — "blind shipping"). Returns go to a return address that must be decided: brand owner's address, our address, or the 3PL's.

*Founder input, default taken in §18:* Whose return address is on the parcel?
*Founder input, default taken in §18:* Which carriers/regions, and is shipping priced as a live rate, a flat table, or included in product cost?

### 1.12 Tracking
Partner reports tracking number + carrier. We store it, push it to the brand's store as a fulfillment (which triggers the store's own shipping-confirmation email to the consumer), and optionally poll/receive carrier tracking events for a status timeline.

### 1.13 Returns & refunds
Messiest area, and the one most often left undesigned until it hurts. Layers:
- Consumer wants a refund → brand owner decides, refunds via their own store. Our cost is already sunk.
- Does the brand get a credit from us? Only for our fault (damaged, wrong item, defect) — that's a **claim**, not a return.
- Physical return of a consumable supplement is usually not resellable; most operators do not accept them back.

*Founder input, default taken in §18:* Do we accept physical returns at all? If yes, to where, restocked or destroyed, and who pays return shipping?
*Founder input, default taken in §18:* What is the claims policy (damaged/lost/wrong item) — window, evidence required, credit vs reship, who absorbs it?

### 1.14 Customer support
Two distinct support surfaces: we support brand owners; brand owners support consumers. We must never be contactable by consumers, or the blind-shipping illusion collapses and our support volume becomes unbounded.

*Founder input, default taken in §18:* Support channel and hours for brand owners; who staffs it.

---

## 2. ACTORS

| Actor | Does | Interacts with | System presence |
|---|---|---|---|
| **Platform owner (you two)** | Curates catalog, negotiates unit costs, sets platform fees, owns compliance posture | Everyone | Admin app, full cross-tenant access |
| **Brand owner** (primary paying user) | Signs up, creates brands, picks products, designs labels, sets prices, connects store, watches orders | Platform, their store, their consumers | Tenant user, scoped to one org |
| **Brand team member** | Same, with fewer rights (designer, VA, bookkeeper) | Platform | Tenant user + role |
| **End consumer** | Buys from the brand's store | Brand's store only | **No account. Stored as a Customer record (PII) for fulfillment only.** |
| **Manufacturer / supplier** | Produces base product, holds bulk stock, applies label, may pack & ship | Platform via adapter; possibly a partner portal | External system + optional portal login |
| **Fulfillment center / 3PL** | Picks, labels, packs, ships; often the same entity as the manufacturer, sometimes not | Platform adapter, carriers | External system |
| **Shipping carrier** | Moves parcel, emits tracking | 3PL, platform (tracking ingest) | External API/webhook |
| **Payment processor** | Two roles: (a) *brand's* processor charges consumers — not ours; (b) *our* processor charges brand owners | Platform billing | External API/webhook |
| **Ecommerce platform** (Shopify, WooCommerce, etc.) | Hosts brand storefront, source of order truth, destination for product/fulfillment sync | Platform integration layer | OAuth app + webhooks |
| **Platform admin / ops** | Approves labels, resolves failed fulfillments, issues credits, manages catalog | Internal | Admin app, audited |
| **Support agent** | Answers brand owners, impersonates tenant for debugging (audited) | Internal | Admin app, restricted role |
| **Compliance reviewer** (may be external counsel/consultant) | Reviews labels, claims, product legality per market | Admin queue | Admin app, narrow role |

Interaction spine: `Consumer → Brand Store → (webhook) → Platform → (adapter) → Manufacturer/3PL → Carrier → Consumer`, with `Platform → (billing) → Brand Owner` running in parallel.

---

## 3. MONEY FLOW

### 3.1 The two loops

**Loop A — retail (we are absent):**
```
Consumer  --$ retail price-->  Brand's payment processor  --minus processor fee-->  Brand owner's bank
```

**Loop B — wholesale (this is us):**
```
Platform  --charges $ (product cost + fulfillment fee + shipping + platform markup)-->  Brand owner's card/wallet
Platform  --pays $ (manufacturing + pick/pack)-->            Manufacturer / 3PL
Platform  --pays $ (postage, if we buy it)-->                Carrier
Platform  retains: markup on unit cost + subscription + service fees
Brand owner retains: retail price - (our charge) - (their processor fee) - (their ad spend)
```

Worked example (illustrative numbers only):
```
Consumer pays                                     $39.99
  Brand's processor fee (~2.9% + $0.30)           -$1.46
  Brand owner gross                                $38.53
Platform charges brand owner:
  Product cost (our cost $6.50 + $2.50 markup)    -$9.00
  Fulfillment / pick-pack fee                     -$2.50
  Shipping (US domestic)                          -$5.95
  Total to platform                               -$17.45
Brand owner net before ad spend                    $21.08
Platform revenue on this order                     $17.45
Platform cost of goods                             -$6.50 (mfr) -$2.00 (3PL) -$5.50 (postage)
Platform gross margin on this order                 $3.45  + subscription MRR
```

### 3.2 Every possible revenue stream
1. **Product markup** — the core. Spread between our negotiated unit cost and what we charge the brand.
2. **Subscription** — monthly/annual plans, tiered by brands, SKUs, order volume, or features (label designer, mockups, API access, multiple stores).
3. **Fulfillment / pick-and-pack fee** — per order and/or per additional item.
4. **Shipping margin** — charging a table rate above actual postage.
5. **Label / design services** — professional label design, done-for-you branding, as a one-off.
6. **Setup / onboarding fee** — one-time, sometimes used to filter tire-kickers.
7. **Storage fees** — only relevant in the stocked/pre-purchased mode.
8. **Custom formulation / white-label project fees** — high-ticket, manual, real revenue for this category.
9. **Sample orders / sample packs** — sold at or above cost to the brand owner.
10. **Rush/priority production fee.**
11. **Failed-payment / retry fee, chargeback handling fee.**
12. **International/remote-area surcharges.**
13. **Per-order transaction fee** (flat, on top of everything) — common but resented.
14. **Affiliate/referral revenue** (brands referring brands) — negative revenue, actually a CAC line.
15. **App-store/ecosystem revenue** — being a paid Shopify app itself.
16. **Data/insight products** — bestseller reports. Ethically tricky, cross-tenant. Not MVP.

### 3.3 Costs to model honestly
Manufacturing, pick/pack, postage, packaging inserts, label printing consumables, storage, damaged/lost-parcel claims, chargebacks from *our* billing of brands, failed-payment write-offs, payment processing on our side, support labor, label-review labor, compliance/legal review, platform infra.

*Founder input, default taken in §18:* Exact fee schedule — subscription tiers/prices, fulfillment fee, shipping pricing method, markup %, and whether markup is per-product or global.
*Founder input, default taken in §18:* Currency(ies) of brand billing, and who bears FX.
*Founder input, default taken in §18:* Payment terms with manufacturers (prepay, net 30?) — determines our working-capital need.

---

## 4. ORDER FLOW & FAILURE AT EVERY STEP

### 4.1 Happy path with explicit states

```
[1] Consumer checks out on brand store
      │
[2] Store fires webhook (orders/create → orders/paid)
      │  verify HMAC → persist raw event → 200 OK immediately → enqueue
[3] Platform ingests: WebhookEvent stored, idempotency key = (integration_id, topic, external_event_id)
      │
[4] Order validation            → state: received
      │  • resolve line items → BrandProduct → SKU  (unmapped item = hard stop)
      │  • validate/normalize address
      │  • check product active, region-shippable, not restricted
      │  • detect duplicate order (same external order id)
      │
[5] Pricing & payment           → state: awaiting_payment
      │  • compute cost lines, charge brand (or debit wallet)
      │
[6] Fulfillment order created   → state: submitted
      │  • adapter translates canonical order → partner payload
      │  • idempotency key sent to partner
      │
[7] Manufacturer accepts        → state: accepted
[8] Production / label applied  → state: in_production
[9] Packed                      → state: packed
[10] Shipped, tracking returned → state: shipped
[11] Tracking pushed to store   → store emails consumer
[12] Carrier events ingested    → state: in_transit → delivered
[13] Terminal                   → delivered | returned | cancelled | refunded
```

Additionally: `on_hold` (any blocking issue), `needs_review` (manual queue), `failed` (terminal only after retries exhausted and a human has been notified).

### 4.2 Failure at each step — what must happen

| Step | Failure | Required behavior |
|---|---|---|
| 2 | Webhook never arrives (store outage, app uninstalled, webhook deleted) | Reconciliation job polls the store's orders API every N minutes for orders we don't have. **Non-negotiable — webhooks are lossy.** |
| 2 | Webhook arrives twice / 50 times | Idempotent ingest on unique event id; replay is a no-op returning the original result. |
| 3 | Signature invalid | Reject 401, log, alert if repeated (probe/attack). |
| 4 | Line item maps to nothing (brand edited SKU in Shopify, added their own product) | Order → `needs_review`. Notify brand owner: "we can't fulfill line X." Never guess a SKU. Partial fulfillment of the mappable items is a *business* decision. |
| 4 | Invalid/undeliverable address | `on_hold`, notify brand owner to correct, provide edit UI, re-validate. Address-correction window before production starts. |
| 4 | Destination country we/the partner cannot ship to (or product is restricted there) | `on_hold` + explicit reason code; brand owner must cancel/refund on their side. |
| 5 | Brand's card declines | `awaiting_payment`, retry schedule (e.g. 0h/6h/24h/72h), email + in-app dunning, hard stop before production. After N failures → `failed`, and if repeated across orders → suspend publishing/fulfillment for that org. |
| 5 | Wallet balance insufficient | Same, plus auto-top-up if configured. |
| 5 | Charge succeeded but our DB write failed | Outbox + idempotency keys on the payment call; reconciliation against processor at the end of every job. Never double-charge. |
| 6 | Manufacturer API 5xx / timeout | Retry with exponential backoff + jitter, capped. Treat timeout as **unknown, not failed**: query the partner by our idempotency key before resubmitting. |
| 6 | Manufacturer API rejects payload (validation) | `needs_review` for ops — this is our bug or stale data, not the brand's problem. |
| 6 | SKU out of stock at partner | `on_hold`; options: wait, substitute (needs brand consent), cancel + refund. Surface expected restock. |
| 7–9 | Production defect / label print failure | Partner-initiated exception → our ops queue → reship at whose cost? (see a §18 default) |
| 10 | Shipping label creation fails at carrier | Retry, then ops queue; often an address issue in disguise. |
| 11 | Store rejects fulfillment push (token revoked, order edited/cancelled in store) | Retry; if token invalid → mark integration `needs_reauth`, alert brand owner. Never lose the tracking number — it stays on our Shipment and can be pushed later. |
| 12 | Carrier shows lost / stuck 10+ days | Automated stale-shipment detector → claims queue. |
| any | Order cancelled in store after production started | Cancellation is only honored before a cutoff state. After that: no cancellation, brand owner eats it (or we do). Must be in the ToS. |
| any | Consumer refunded by brand owner | Refund on the retail side does **not** automatically refund our charge. Separate credit-note flow, policy-driven. |
| any | Webhook arrives out of order (`fulfilled` before `created`, `updated` before `created`) | Version/sequence check per aggregate; buffer or re-fetch canonical state from the store API rather than trusting event order. |

Design rule: **every failure resolves to (a) automatic retry, (b) a task in a human work queue, or (c) a notification to the brand owner with a clear action.** No order may ever silently stall with no owner. A daily "orders stuck in non-terminal state > X hours" alert is the safety net for everything we failed to imagine.

---

## 5. SOFTWARE ARCHITECTURE

### 5.1 MVP architecture (build this)

Deliberately boring, one deployable, one database. Two people cannot operate microservices.

```
┌───────────────────────────────────────────────────────────────────┐
│  Brand App (Next.js, TS)     │  Admin App (same codebase, /admin) │
│  - catalog, label designer    │  - catalog CRUD, label approvals   │
│  - orders, billing, settings  │  - failed fulfillments, credits    │
└───────────────┬───────────────┴──────────────┬─────────────────────┘
                │ server actions / REST        │
┌───────────────▼──────────────────────────────▼─────────────────────┐
│                    Application (modular monolith)                  │
│  modules: auth · tenancy · catalog · branding · integrations ·     │
│           orders · fulfillment · billing · notifications · admin   │
│  strict module boundaries, no cross-module DB reads                │
└───┬───────────┬────────────┬─────────────┬────────────┬────────────┘
    │           │            │             │            │
┌───▼────┐ ┌────▼─────┐ ┌────▼──────┐ ┌────▼─────┐ ┌────▼─────────┐
│Postgres│ │Job queue │ │Object     │ │Payments  │ │Email/SMS     │
│(+RLS)  │ │+ scheduler│ │storage    │ │(Stripe)  │ │(Resend/SES)  │
└────────┘ └────┬─────┘ │(S3/R2)+CDN│ └──────────┘ └──────────────┘
                │        └───────────┘
      ┌─────────┴──────────┬────────────────────┐
┌─────▼──────┐  ┌──────────▼────────┐  ┌────────▼─────────┐
│Shopify     │  │Fulfillment        │  │Tracking / carrier│
│adapter     │  │adapter (per mfr)  │  │adapter           │
└────────────┘  └───────────────────┘  └──────────────────┘
```

Concrete MVP stack recommendation (justified, not fashionable):

- **Next.js + TypeScript** — one language across the stack for a solo developer; server components for the dashboard; API routes for webhooks. Alternative if you prefer harder backend boundaries: NestJS API + separate React app. Do not pick both a Node backend and a Python service in MVP.
- **PostgreSQL** (Neon/Supabase/RDS) — relational, transactional, JSONB where the shape is partner-specific, row-level security for tenant isolation. Non-negotiable for money and orders.
- **Prisma or Drizzle** — Drizzle if you want SQL-first and fewer surprises with RLS; Prisma for velocity.
- **Auth**: managed (Clerk/WorkOS/Auth0) or Supabase Auth. Do **not** hand-roll sessions, password reset, and MFA — it is weeks of work and the failure mode is catastrophic.
- **Background jobs**: durable, retryable, with scheduling. Inngest or Trigger.dev (managed, step-level retries, good DX) or BullMQ + Redis (self-managed, cheaper, more ops). Everything touching an external API runs as a job, never inline in a request.
- **Object storage**: S3 or Cloudflare R2, private buckets, presigned uploads, CDN for derivatives.
- **Payments**: Stripe for charging brand owners (subscriptions + off-session per-order charges + wallet top-ups). Justified below in §10.
- **Email**: transactional provider with templates and webhooks (Resend/Postmark/SES).
- **Errors/logs/metrics**: Sentry + the platform's logs + one uptime monitor. That is enough at MVP.
- **Hosting**: Vercel/Render/Fly for app, managed Postgres, managed Redis if needed. Containerize early enough that you can leave.

Explicitly **not** in MVP: Kubernetes, event bus/Kafka, microservices, GraphQL federation, service mesh, multi-region, CQRS, data warehouse, self-hosted auth, own 3D renderer.

### 5.2 Scale architecture (know where the seams are)

When volume and team justify it, split along the boundaries the monolith already has:

- **Integration/webhook ingress** as its own always-available service (highest traffic, must never be blocked by app deploys; Shopify will delete webhooks that repeatedly fail).
- **Fulfillment service** — adapters, per-partner rate limits and circuit breakers, retry state machines.
- **Order service** — order state machine as the system of record; consider an append-only event log per order (you will want the audit trail anyway, so model `OrderEvent` from day one).
- **Billing service** — ledger, invoices, dunning, credits. Once real money is disputed you want a double-entry ledger, not computed sums.
- **Media/render service** — mockup and print-file generation is CPU-heavy and bursty; isolate it and scale to zero.
- **Notification service** — templated, multi-channel, preference-aware.
- **Search** — Postgres FTS until catalog + filters hurt, then Meilisearch/Typesense/OpenSearch.
- **Analytics** — CDC/ETL into a warehouse (BigQuery/Snowflake/ClickHouse) and stop running reports off the transactional DB.
- **Read replicas, caching (Redis), per-tenant rate limiting, multi-region storage, DB partitioning of `order_events`/`webhook_events`** (the two tables that grow without bound).

The single most valuable scale decision made at MVP time: **an internal event/outbox table** so that "order shipped" can later fan out to many consumers without rewriting the order module.

---

## 6. DATABASE DESIGN

Conventions: UUID v7 primary keys; `org_id` on every tenant-owned table; `created_at`/`updated_at`; soft delete only where legally needed; money as integer minor units + currency code (**never floats**); enums as Postgres enums or check-constrained text; all external references stored as `external_*_id` plus the integration they belong to.

### 6.1 Tenancy & identity
- **User** — id, email (unique), name, hashed_password/auth_provider_id, mfa, last_login. A user may belong to several orgs.
- **Organization** *(the tenant)* — id, name, country, billing_email, plan_id, status (`active|past_due|suspended`), stripe_customer_id, wallet_balance_minor, settings JSONB.
- **Membership** — user_id, org_id, role (`owner|admin|member|designer|read_only`), invited_by, accepted_at. Unique (user_id, org_id).
- **Invitation** — org_id, email, role, token_hash, expires_at.
- **ApiKey** — org_id, name, prefix, hashed_secret, scopes, last_used_at, revoked_at.
- **AuditLog** — org_id (nullable for platform actions), actor_user_id, actor_type (`user|admin|system|integration`), action, entity_type, entity_id, before/after JSONB, ip, user_agent, created_at. Append-only.

### 6.2 Brand & catalog
- **Brand** — org_id, name, slug, logo_asset_id, colors JSONB, story, support_email, return_address JSONB, status.
- **Supplier** — legal entity we buy from: name, contact, country, terms, payment_terms, status.
- **Manufacturer** — often = supplier, but keep separate: produces goods; has capabilities, lead_time_days, certifications, adapter_key.
- **FulfillmentCenter** — physical node: manufacturer_id/supplier_id, address, country, regions_served, carrier_accounts, cutoff_times, adapter_key, is_active.
- **CatalogProduct** *(platform-owned, no org_id)* — name, category_id, description, ingredients, spec JSONB, mode (`on_demand|stocked`), label_template_id, default_msrp_minor, compliance docs, restricted_countries, status (`draft|active|discontinued`).
- **CatalogVariant / SKU** — the manufacturable unit: catalog_product_id, sku (unique), attributes JSONB (size, flavor, count), weight_grams, dimensions, barcode, hs_code, base_cost_minor, currency, moq, lead_time_days, is_active. Prices vary by fulfillment center → **SkuCost**(sku_id, fulfillment_center_id, cost_minor, currency, effective_from/to) so cost changes are historical, not destructive.
- **Category**, **ProductImage/Asset** links.
- **LabelTemplate** — sku_id or catalog_product_id, print spec (dimensions_mm, bleed, safe_area, dpi, color_profile, die-line asset), editable_fields JSONB, fixed_panels (supplement facts) asset refs.

### 6.3 Brand-owned product instances
- **BrandProduct** — org_id, brand_id, catalog_product_id, title, description, retail_price_minor, currency, status (`draft|pending_review|approved|published|unpublished|archived`), primary_mockup_asset_id. Unique (brand_id, catalog_product_id) unless multiple designs per product are allowed.
- **BrandProductVariant** — brand_product_id, sku_id, retail_price_minor, external mapping fields, is_active. **This is the row an incoming order line resolves to.**
- **Label** — org_id, brand_id, brand_product_id, label_template_id, version (int), design_state JSONB (layers, text, colors, transforms — the editable document), preview_asset_id, print_file_asset_id, status (`draft|submitted|approved|rejected|superseded`), reviewed_by, reviewed_at, rejection_reason. **Versioned and immutable once approved** — an order must reference the exact label version that was printed.
- **Asset** — org_id (nullable for platform assets), kind (`logo|label_print|label_preview|mockup|product_image|document`), storage_key, bucket, mime, bytes, width/height, checksum, virus_scan_status, uploaded_by, is_public. DB stores metadata only.

### 6.4 Stores & integrations
- **Integration** — org_id, provider (`shopify|woocommerce|manual|api`), external_shop_id/domain, status (`connected|needs_reauth|disconnected`), scopes, installed_at, last_sync_at, **credentials stored encrypted (KMS/envelope) — never plaintext tokens**.
- **Store** — either merged with Integration or separate when one integration can expose multiple storefronts/markets: integration_id, brand_id, domain, currency, default_location_id.
- **ProductSyncMapping** — brand_product_variant_id, integration_id, external_product_id, external_variant_id, external_inventory_item_id, last_pushed_at, last_push_hash, sync_status, error. Unique on (integration_id, external_variant_id).
- **WebhookEvent** — provider, integration_id (nullable), topic, external_event_id, payload JSONB (raw), signature_valid, received_at, processed_at, status (`received|processed|failed|ignored`), attempts, error, dedupe_key **UNIQUE**. Retention policy + partition by month.
- **OutboxEvent** — aggregate_type, aggregate_id, event_type, payload, created_at, published_at, attempts. Guarantees "DB change + side effect" atomicity.

### 6.5 Orders & fulfillment
- **Customer** *(the consumer — brand's customer)* — org_id, brand_id, external_customer_id, email, phone, name. Minimize; consider not storing beyond the order. Addresses either inline on the order (recommended, immutable snapshot) or **Address** rows.
- **Order** — org_id, brand_id, integration_id, external_order_id, external_order_number, customer_id, ship_to JSONB *(snapshot)*, bill_to JSONB, currency, retail_subtotal_minor, retail_shipping_minor, retail_total_minor (informational — for margin reporting), status enum (§4.1), placed_at, imported_at, hold_reason, risk_flags JSONB. **UNIQUE (integration_id, external_order_id).**
- **OrderItem** — order_id, brand_product_variant_id (nullable when unresolved), sku_id, label_id *(exact version printed)*, quantity, retail_unit_price_minor, cost_unit_minor, fulfillment_fee_minor, status (items can diverge — partial fulfillment), external_line_item_id.
- **OrderEvent** — order_id, type, from_status, to_status, actor, payload JSONB, created_at. Append-only timeline; powers support, debugging, and the brand-facing order detail page.
- **FulfillmentOrder** — order_id, fulfillment_center_id, adapter_key, external_fulfillment_id, idempotency_key **UNIQUE**, status, submitted_at, accepted_at, request/response snapshots JSONB, attempts, last_error. One order may have several (multi-warehouse split, partial).
- **Shipment** — fulfillment_order_id, carrier, service, tracking_number, tracking_url, shipped_at, delivered_at, weight, cost_minor, label_asset_id, pushed_to_store_at, status. **UNIQUE (carrier, tracking_number)** where feasible.
- **ShipmentItem** — shipment_id, order_item_id, quantity (needed for partial shipments).
- **TrackingEvent** — shipment_id, occurred_at, status_code, description, location, raw JSONB, source. Unique on (shipment_id, occurred_at, status_code) to survive duplicate carrier pushes.
- **Inventory** — sku_id, fulfillment_center_id, on_hand, reserved, available, safety_stock, updated_at, source (`partner_feed|manual`). For `stocked` mode add **BrandInventory**(org_id, sku_id, label_id, quantity) — brand-owned units.
- **InventoryLedger** — sku_id, location, delta, reason, ref_type/ref_id. If you ever need to explain a stock number, you need this.

### 6.6 Money
- **Plan** — code, name, price_minor, interval, limits JSONB, features JSONB.
- **Subscription** — org_id, plan_id, provider_subscription_id, status, current_period_start/end, cancel_at, trial_end.
- **Charge / Payment** — org_id, order_id (nullable), kind (`order|subscription|wallet_topup|service_fee`), amount_minor, currency, provider, provider_payment_intent_id, status (`requires_action|pending|succeeded|failed|refunded|disputed`), failure_code, attempts, idempotency_key UNIQUE.
- **PaymentMethod** — org_id, provider_pm_id, brand, last4, exp, is_default, status. (Never store PAN.)
- **WalletTransaction** — org_id, delta_minor, balance_after_minor, reason, ref_type/ref_id. Append-only, if wallet model chosen.
- **Invoice** + **InvoiceLine** — org_id, number, period, subtotal/tax/total, status, pdf_asset_id, provider_invoice_id; lines reference orders/fees.
- **CreditNote** — org_id, amount_minor, reason, related order/claim.
- **Refund** — payment_id, amount_minor, reason, provider_refund_id, status. (Refund of *our* charge to the brand, distinct from the brand refunding their consumer.)
- **Return** — order_id, rma_number, reason, status (`requested|approved|in_transit|received|inspected|restocked|destroyed|rejected`), return_shipment_id, resolution, cost_bearer.
- **Claim** — order_id/shipment_id, type (`damaged|lost|wrong_item|defect|late`), evidence asset ids, status, resolution (`credit|reship|denied`), amount_minor.
- **Payout** *(only if we ever hold consumer funds — currently not needed)*.

### 6.7 Platform ops
- **Notification** — org_id/user_id, channel, template, payload, status, sent_at, read_at.
- **Task / ReviewQueueItem** — type (`label_review|failed_fulfillment|address_hold|payment_hold|claim`), entity ref, assignee, status, priority, due_at. One unified work queue beats five bespoke admin screens.
- **FeatureFlag**, **Setting**, **IdempotencyKey**(key, scope, request_hash, response, expires_at) for our own public API.

### 6.8 Relationship summary
```
User *—* Organization (via Membership)
Organization 1—* Brand 1—* BrandProduct *—1 CatalogProduct 1—* SKU
BrandProduct 1—* BrandProductVariant —1 SKU
BrandProduct 1—* Label (versioned)
Organization 1—* Integration 1—* Store
BrandProductVariant 1—* ProductSyncMapping —1 Integration
Integration 1—* Order 1—* OrderItem —1 BrandProductVariant
Order 1—* FulfillmentOrder 1—* Shipment 1—* TrackingEvent
Order 1—* OrderEvent  |  Order 1—* Charge  |  Order 1—* Return/Claim
Manufacturer 1—* FulfillmentCenter 1—* Inventory —1 SKU
Organization 1—1 Subscription —1 Plan ; Organization 1—* Invoice/WalletTransaction
```

---

## 7. MULTI-TENANCY

### 7.1 Strategy: shared database, shared schema, `org_id` everywhere, enforced in depth

Rejected alternatives: DB-per-tenant (unmanageable migrations for a 2-person team at thousands of tenants), schema-per-tenant (same problem, subtler). Revisit only for a future enterprise tier.

### 7.2 Defense in depth — four layers, because one is never enough

1. **Request scope.** Auth resolves `user → membership → org_id` server-side. `org_id` is **never** accepted from the client, a URL, or a header. Tenant context is established once per request in middleware and carried implicitly.
2. **Data access layer.** Every query goes through a tenant-scoped repository/client that injects `org_id`. Forbid raw unscoped queries by lint rule and code review. A single `findUnique({ where: { id } })` without an org check is the classic breach.
3. **Postgres Row-Level Security.** Policies `USING (org_id = current_setting('app.current_org')::uuid)` on every tenant table, with the app connecting as a non-bypassing role and setting the GUC per transaction. This catches the bug the ORM layer missed. A separate privileged role exists for admin/migrations/jobs, used deliberately and audited.
4. **Tests.** A permanent cross-tenant test suite: for every endpoint, tenant A attempts to read/modify tenant B's entity and must get 404 (not 403 — don't leak existence). Add a CI check that fails when a new tenant table lacks an RLS policy.

### 7.3 Per-resource isolation

- **Products** — catalog is shared and read-only to tenants; `BrandProduct`/`Label` are tenant-scoped. Never leak another brand's label design, mockups, or retail price.
- **Customers & orders** — tenant-scoped and PII-bearing. Search must be scoped; exports must be scoped and audited.
- **Revenue** — no cross-tenant aggregates in tenant-facing code paths.
- **Files** — private buckets, keys namespaced `org/{org_id}/...`, access only via short-lived presigned URLs generated after an authorization check. Public CDN URLs for mockups are acceptable only if they are unguessable and contain nothing sensitive. Never make the bucket listable.
- **Integrations & credentials** — encrypted per-row with envelope encryption; decryption only inside the integration module; tokens never logged, never returned by any API, masked in admin UI.
- **API keys** — hashed, prefixed for identification, scoped to one org, rate-limited per org.
- **Jobs** — every job payload carries `org_id`; workers re-establish tenant context and re-authorize. A job is not trusted just because it is internal.
- **Background/admin access** — platform admins can cross tenants by design. Every cross-tenant read is audit-logged, impersonation is time-boxed, explicit, and visible.
- **Noisy-neighbor isolation** — per-org rate limits and job concurrency caps so one brand's flash sale cannot starve everyone.

---

## 8. PRODUCT CUSTOMIZATION

### 8.1 Flow
1. **Choose base product** → pick SKU → system loads its `LabelTemplate` (die-line, bleed, safe area, DPI, color profile, fixed supplement-facts panel).
2. **Upload logo** → presigned direct-to-storage upload; validate real MIME by magic bytes, dimensions, DPI, file size; prefer SVG/PNG/PDF; virus scan; reject CMYK/RGB mismatches with a clear message; store as `Asset`.
3. **Create label** → browser-based editor over a fixed canvas mapped 1:1 to print dimensions. Editable: brand name, logo placement, colors, flavor/variant text, optional marketing line. Locked: supplement facts, allergen statements, net quantity, manufacturer details, barcode area. Persist the **design document as JSON** (`Label.design_state`) — never only a flattened image, or the user can never edit it again.
4. **Preview** → fast client-side render for interaction + authoritative server-side render for anything that matters. Client and server renderers must agree; safest is a single renderer running server-side generating a preview PNG on save.
5. **Mockups** → composite the flat label onto product photography. MVP: pre-shot bottle photos + displacement/warp map per template, generated server-side (sharp/ImageMagick/headless Chromium). Later: 3D (Three.js/Blender) or a mockup API vendor. Generate a small set of standard mockups per product and store as assets for use as store images.
6. **Approve** → brand owner submits; label enters `pending_review`; reviewer checks print-readiness (resolution, bleed, safe area, fonts embedded/outlined, no placeholder text) and compliance red flags. Approve → generate the **print-ready file** (PDF/X with correct color profile, bleed, marks) and freeze the version.
7. **Publish** → push BrandProduct to the store with mockups as images; store the sync mapping; product becomes orderable.

Critical rule: **the print file is generated and frozen at approval, and orders reference `label_id` (versioned).** If the brand edits their label, a new version is created; in-flight orders keep the old one. Without this, you cannot answer "which artwork did we actually print on order #1043?"

### 8.2 Database vs object storage

| Store in Postgres | Store in object storage |
|---|---|
| Label design document (JSON layers/text/colors/transforms) | Uploaded logos and source artwork |
| Asset **metadata** (key, mime, size, checksum, dimensions, scan status) | Rendered previews (PNG/WebP) |
| Versions, statuses, review decisions, reviewer, timestamps | Mockup images and their derivatives |
| Template print specs & editable-field schemas | Print-ready PDF/X output |
| Mappings to external store product/variant IDs | Die-lines, fixed panels, spec sheets, compliance PDFs, invoices |
| Approval audit trail | Anything large, binary, or immutable |

Rules: never store binaries in the DB; never keep the only copy of a print file on a server disk; content-addressable keys (checksum) for dedupe and integrity; lifecycle rules to move old derivatives to cold storage; keep print files for as long as claims/regulatory windows require (*Founder input, default taken in §18:* retention period for print files and order records).

---

## 9. ECOMMERCE INTEGRATIONS

Design the integration layer as a **provider interface** from day one, even with only Shopify implemented:
`connect/authorize`, `listProducts`, `pushProduct`, `updateInventory`, `fetchOrders(since)`, `pushFulfillment`, `pushTracking`, `verifyWebhook`, `subscribeWebhooks`, `disconnect`.

### 9.1 OAuth & tokens
- Public app OAuth: install → scope grant → authorization code → exchange for access token → verify HMAC on the callback and validate the shop domain → persist encrypted with scopes and granted timestamp.
- Request minimum scopes (products write, orders read, fulfillments write, inventory write).
- Handle **scope upgrades** (re-consent when we add features) and token revocation.
- Support per-org **multiple stores**, and the same store connecting to only one org (detect and refuse hijack attempts).

### 9.2 Webhooks
- Verify HMAC with the app secret on the raw body before parsing. Reject on mismatch.
- Persist raw event, respond **200 within the platform's timeout budget (Shopify: 5s)**, process asynchronously. Slow handlers get your webhooks deleted.
- Dedupe on the platform's event id header; treat every topic as at-least-once.
- Subscribe to: `orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled`, `refunds/create`, `fulfillments/update`, `products/update`, `products/delete`, `app/uninstalled`, and the mandatory GDPR/compliance topics (customer data request, customer redact, shop redact) if publishing to the app store.
- Reconcile by polling regardless — webhooks are lossy and out-of-order.

### 9.3 Product sync
- One-way push (platform → store) as the default; treat our data as source of truth for cost/SKU, the store as source of truth for orders.
- Track `last_push_hash` to skip no-op pushes and stay inside API rate limits.
- Handle: product deleted in store (mark mapping broken, offer republish), variant edited in store (SKU drift — the #1 cause of unmappable orders; detect on `products/update` and warn), price edited in store (allowed — retail price is the brand's business), title/description edits (allowed; do not fight the user by overwriting).
- Two-way "import my existing product and link it to a catalog SKU" is a valuable later feature; MVP can require publishing from us.

### 9.4 Inventory sync
- We publish availability from partner `Inventory` (or "always in stock" for on-demand production). Push updates on change and on a schedule; respect rate limits; batch.
- Oversell handling: on-demand mode rarely overse­lls, stocked mode does — reserve on order import and reconcile.

### 9.5 Order sync
- Ingest on paid (not merely created) unless the brand uses manual payment capture (*Founder input, default taken in §18:* do we fulfill unpaid/COD orders?).
- Map line items via `ProductSyncMapping` by external variant id first, SKU second, never by title.
- Ignore/flag: test orders, draft orders, orders containing only non-catalog items (brand sells their own stuff too — extremely common; must not error, must fulfill only our lines).
- Respect order edits and cancellations up to the production cutoff.

### 9.6 Fulfillment & tracking updates back to the store
- Create a fulfillment on the external order with tracking number, carrier, tracking URL, and the exact line items shipped. This is what emails the consumer — so it must be idempotent and must never fire twice.
- Support partial fulfillments and multiple shipments per order.
- On failure, retry with backoff and keep the tracking data durable locally.

### 9.7 Disconnect / reconnect
- `app/uninstalled` → mark integration `disconnected`, stop all sync jobs, **do not delete order history** (needed for billing and support), pause auto-fulfillment, notify.
- Token invalid (401) → `needs_reauth`, prominent in-app banner, halt pushes, queue nothing indefinitely.
- Reconnect → same shop domain reattaches to the existing integration record and its mappings; verify the org matches; re-verify webhook subscriptions; run a catch-up order fetch for the gap.
- Store the "last successfully synced order timestamp" per integration so a gap is always recoverable.
- Reinstall to a *different* org → require manual review; this is a data-leak vector.

---

## 10. PAYMENT ARCHITECTURE

> **Deferred for v1 (25 Sep 2026).** No processor is integrated at launch; billing is manual and offline. Everything below is the target design. What gets built now is the seam: a `PaymentProvider` interface with a `manual` implementation, plus server-side pricing and the ledger, so orders carry correct, auditable money from day one and a provider drops in behind an unchanged interface. Read §0.1 first.

### 10.1 What we do and don't handle

| Flow | Who | Our involvement |
|---|---|---|
| Consumer pays retail | Brand's own processor | **None.** We read the amounts from the order for margin reporting only. |
| Brand pays us per order | Our processor | **Core.** Off-session card charge / wallet debit. |
| Brand pays subscription | Our processor | Core. Recurring. |
| We pay manufacturer | Bank/AP | Outside the product initially (manual AP, reconciled from reports). |
| We pay carrier | Usually inside partner cost | Outside product. |
| Brand refunds consumer | Brand's processor | None; we may issue a credit note separately. |

### 10.2 Provider choice
Stripe is the justified default **for charging brand owners**: off-session payments with saved methods and SCA/3DS handling, subscriptions and metered/usage billing, invoices, customer balance (usable as a wallet), strong idempotency semantics, webhooks, disputes, and tax support. Adyen/Braintree are viable but heavier to onboard for a two-person team. The requirement that actually drives the choice is *reliable off-session recurring charges with SCA compliance and a usable balance/credit primitive* — not brand preference.

We deliberately do **not** need Stripe Connect/marketplace payouts, because we never hold the brand's retail revenue. If the model changes so that we host storefronts and collect consumer payments, then Connect (or an equivalent) and seller KYC become mandatory and the compliance surface grows dramatically.

### 10.3 Charge model — pick one
- **(a) Per-order charge at import.** Simplest to reason about, best cash flow, worst UX (many small charges, decline risk mid-day, card-testing-like patterns).
- **(b) Prepaid wallet with auto-top-up.** Fulfillment never blocks on a card, decline risk moves to top-up time, needs a ledger and refund-to-wallet rules. Best operational fit for high order volume.
- **(c) Net-terms invoicing.** Sales-friendly, requires credit decisions and collections. Not MVP.

Recommendation: build **(a) with the ledger abstraction that makes (b) a small step**, i.e. every order charge writes to an internal ledger regardless of funding source. a §18 default remains the founders' call.

### 10.4 Mechanics that must be right
- **Idempotency keys** on every charge, derived from `order_id + attempt_purpose` — never a random value generated per retry.
- **Authorize vs capture**: consider authorizing at import and capturing at shipment, if the gap is short; otherwise charge once, before submitting to production.
- **Webhook-driven state**: never trust the API response alone; reconcile on `payment_intent.succeeded/failed`, `invoice.*`, `charge.dispute.created`.
- **SCA/3DS**: off-session charges can require action. Needs an "action required" state, an email with a hosted confirmation link, and an order hold.
- **Dunning**: retry schedule, escalating notifications, then suspension of fulfillment and publishing; keep the org's data intact.
- **Disputes/chargebacks from brand owners** — evidence packet automation is a later win; a documented manual process is enough at MVP.
- **Refunds/credits to brands** — reason-coded, approval-gated, ledger-recorded; prefer credit notes to card refunds.
- **Tax** — sales tax/VAT on our B2B charges is a real question (a §18 default), separate from the tax the brand owes on retail sales (theirs, not ours — but they will ask us about it anyway).
- **PCI** — use hosted fields/Checkout so card data never touches our servers (SAQ-A). Never log or store PAN/CVV. This is non-negotiable.
- **Never trust client-side amounts.** Prices are always recomputed server-side from catalog cost + fee schedule at charge time, with the applied fee schedule version recorded on the order.

---

## 11. MANUFACTURER / FULFILLMENT INTEGRATION

> **Partially deferred for v1 (25 Sep 2026).** No manufacturer is signed, so no API adapter is written. The abstraction below is built in full now, and the **spreadsheet adapter is its first implementation** — the manual path is a first-class adapter, not a bypass. Read §0.1 first.

### 11.1 The abstraction
```
                        ┌──────────────────────────────┐
  Order module ───────▶ │ FulfillmentService           │
  (canonical order)     │  - routing (which center?)   │
                        │  - canonical → adapter call  │
                        │  - retries, circuit breaker  │
                        │  - status normalization      │
                        └───────────┬──────────────────┘
                                    │  FulfillmentProvider interface
            ┌───────────────┬───────┴────────┬─────────────────┐
     ┌──────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐ ┌────────▼────────┐
     │ MfrA (REST) │ │ MfrB (REST) │ │ MfrC (CSV/   │ │ Manual (ops UI  │
     │  webhooks   │ │  polling    │ │ SFTP/email)  │ │  + email)       │
     └─────────────┘ └─────────────┘ └──────────────┘ └─────────────────┘
```

**The manual adapter is mandatory in MVP.** Your first manufacturer almost certainly has no API. Build the canonical model + the manual/CSV adapter first; a REST adapter added later must not change a single line of the order module. If the order module ever contains the word "ShipBob" or a partner's field name, the abstraction has failed.

### 11.2 The interface (stable, partner-agnostic)
```
submitOrder(canonicalOrder, idempotencyKey) -> { externalId, status }
getOrder(externalId)                        -> { status, shipments[], exceptions[] }
cancelOrder(externalId)                     -> { ok | too_late }
getInventory(skus[])                        -> [{ sku, available, location }]
getShippingQuote(items, destination)        -> [{ service, cost, eta }]   // optional
handleWebhook(rawPayload, signature)        -> normalized events[]
getArtifacts(externalId)                    -> labels, docs
```

Plus per-adapter metadata: capabilities (`supports_cancel`, `supports_partial`, `supports_webhooks`, `requires_prepaid_label`), rate limits, cutoff times, SKU-code mapping, status-code mapping table, address-format requirements, retry policy.

### 11.3 Canonical concerns
- **SKU mapping** — our SKU ≠ their item code. `PartnerSkuMapping(sku_id, fulfillment_center_id, partner_code)`. Never send our internal id blindly.
- **Status normalization** — a lookup table from partner statuses to our enum, with an explicit `unknown` bucket that raises an ops task rather than silently mapping to something plausible.
- **Artwork delivery** — presigned URL, SFTP drop, or pre-registered artwork per brand-SKU. Registering artwork once (partner-side "brand profile") is much cheaper than attaching a PDF to every order; support both.
- **Routing** — choose the fulfillment center by destination region, stock, cost, and lead time. MVP: one center per SKU, hardcoded rules. Later: a routing engine.
- **Reconciliation** — daily job comparing our open fulfillment orders against the partner's list; surfaces silently dropped orders, which absolutely will happen.
- **Cost truth** — partner invoices vs. what we charged the brand. A monthly variance report protects the margin.
- **Sandbox** — every adapter needs a fake/sandbox implementation for tests and local dev.

*Founder input, default taken in §18:* Who are the actual launch manufacturers, what integration capability do they have (API / CSV / email / portal), and what is their SLA?
*Founder input, default taken in §18:* Do they support blind shipping with per-order label application, and at what unit price and MOQ?
*Founder input, default taken in §18:* Which countries can they ship to, from which facilities?

---

## 12. ADMIN DASHBOARD

Priority order matters — the admin app is an operations tool, not a reporting toy. Build the work queues first.

**Tier 1 — operations (day one, or the business does not run):**
- **Unified work queue**: label reviews, failed fulfillments, payment holds, address holds, unmapped order lines, claims. Assignable, filterable, with SLA/ageing.
- **Order search & detail**: full timeline (OrderEvent), raw webhook payloads, adapter request/response, charge status, shipments, and manual actions — retry fulfillment, resubmit, mark shipped, cancel, add tracking, force-resolve line mapping, push fulfillment to store again.
- **Integration health**: per-org connection status, last sync, webhook failure counts, reauth needed.
- **Catalog management**: products, SKUs, costs per center, lead times, restricted countries, templates, activate/discontinue, price-change history.
- **Label approval queue** with print-spec checks and annotated rejection reasons.

**Tier 2 — commercial:**
- Organizations & brands: plan, status, order volume, GMV, lifetime spend, payment health, suspend/reactivate, impersonate (audited, time-boxed).
- Users: roles, last login, MFA status, password reset, disable.
- Payments: charges, failed charges, dunning state, disputes, wallet balances, credits issued, refunds.
- Subscriptions: MRR, churn, plan distribution, trials, past-due.
- Revenue: platform revenue by stream (markup / subscription / fulfillment fee / shipping margin), gross margin per order, per brand, per SKU, cost variance vs partner invoices.
- Suppliers/manufacturers/fulfillment centers: performance — acceptance time, production time, on-time ship %, defect/claim rate, cost trend.
- Shipping: cost vs charged, carrier mix, transit times, stale shipments, lost-parcel rate by lane.

**Tier 3 — platform health & trust:**
- System health: job queue depth, failure rate, oldest unprocessed job, webhook backlog, adapter error rates and circuit-breaker state, external API latency, DB health, error budget.
- Webhook failures: searchable, replayable **per event** (replay must be idempotent-safe).
- Suspicious activity: many failed payments for one org, mismatch between retail price and cost (fraud or misconfiguration), unusual order velocity, many orders to one address, repeated address changes post-production, bulk exports of customer data, multiple orgs sharing a card, high-risk destination countries, chargeback clusters.
- Audit log viewer (who did what, cross-tenant access log).
- Feature flags, fee schedule versions, announcement/banner tooling.

Admin must run on a separate route/host with independent authz, mandatory MFA, IP allowlisting if practical, and every mutation audited.

---

## 13. FAILURE HANDLING, IDEMPOTENCY & RETRIES

### 13.1 Core primitives
1. **Idempotent ingest.** `webhook_events` with `UNIQUE(provider, integration_id, topic, external_event_id)`. Insert first; on conflict, no-op. Store raw payload before any parsing.
2. **Idempotent egress.** Every outbound side effect carries a deterministic idempotency key stored on our row *before* the call: `fulfillment:{order_id}:{attempt_group}`, `charge:{order_id}`, `fulfillment_push:{shipment_id}`. Deterministic, not random.
3. **Outbox pattern.** State change and event emission commit in the same transaction; a publisher drains the outbox. This eliminates "we shipped but never told the store."
4. **Explicit state machine.** Allowed transitions declared in code; illegal transitions throw. `applyTransition(order, event)` is the only mutation path, and it writes an `OrderEvent`.
5. **Retries**: exponential backoff + full jitter, bounded attempts, per-error-class policy — retry 429/5xx/timeouts; never retry 4xx validation errors (those are bugs or bad data → human queue).
6. **Dead-letter queue** + alert. Nothing disappears.
7. **Circuit breaker** per external dependency, with a degraded mode: keep accepting and queueing orders while a manufacturer's API is down; do not fail the brand's order because a partner is offline.
8. **Timeout = unknown.** Always reconcile by idempotency key before resubmitting. This is the rule that prevents double-manufacturing.
9. **Reconciliation jobs** for every external system: orders (vs store), fulfillments (vs partner), charges (vs processor), shipments (vs carrier). Daily minimum.
10. **Stuck-entity monitor**: anything non-terminal beyond its expected duration raises a task. This catches unknown unknowns.

### 13.2 Case by case

| Scenario | Mechanism |
|---|---|
| Duplicate webhook | Unique dedupe key; replay returns cached outcome. |
| Duplicate order (same external id) | `UNIQUE(integration_id, external_order_id)`; second insert resolves to the existing order. |
| Near-duplicate order (consumer ordered twice) | **Not** deduped automatically — different external ids are different orders. Flag for review only if same address+items within minutes; never auto-cancel. |
| Manufacturer API failure | Retry + backoff; circuit breaker; order stays `awaiting_submission`; ops alert after threshold; nightly reconciliation. |
| Manufacturer API timeout | Query by idempotency key before any resubmit; if indeterminate, park in `needs_review` rather than risk a double order. |
| Payment failure | Dunning schedule; `awaiting_payment`; no production; escalate to suspension; notify brand with a fix link. |
| SCA required | `requires_action` state + email with hosted confirm link + expiry; auto-cancel-to-review after N days. |
| Shipping/label failure | Retry; then ops queue; check address validity first. |
| Invalid product / discontinued SKU at order time | Honor if possible (we discontinued it, not them) else `on_hold` with a clear reason + brand notified; never silently substitute. |
| Unavailable SKU (stockout) | `on_hold` with ETA; options wait/substitute/cancel; block further publishing if persistent. |
| Partial fulfillment | Item-level statuses; multiple FulfillmentOrders/Shipments; push partial fulfillment to store; charge only what shipped, or charge and credit — decide (a §18 default). |
| Refund (consumer side) | Recorded for reporting; our charge is unaffected unless policy grants credit. |
| Cancellation | Allowed only before `in_production`; after cutoff, reject with explanation; if the store cancels anyway, order continues and brand is billed (must be in ToS). |
| Out-of-order webhooks | Per-aggregate sequence/version; if an event implies an unseen earlier state, fetch canonical state from the source API instead of trusting order. Ignore events older than current state. |
| Webhook flood / retry storm | Fast 200 + async processing; per-integration rate limit; queue backpressure. |
| Our own deploy mid-flight | Jobs idempotent and resumable; no long-running in-request work; graceful shutdown drains. |
| Partner ships something we never sent | Reconciliation surfaces the orphan; ops links or rejects it. |

---

## 14. SECURITY REQUIREMENTS (production)

**Authentication** — managed provider or battle-tested library; argon2id if self-managed; MFA (TOTP) at least for admins and offered to owners; secure session cookies (HttpOnly, Secure, SameSite=Lax, short-lived + rotation); device/session list and revoke; safe password reset (single-use, expiring, no user enumeration); lockout/backoff on credential stuffing; email verification.

**Authorization** — RBAC with explicit permissions per role; deny by default; server-side checks on every action (never hide-in-UI); object-level checks (`entity.org_id === ctx.org_id`) on every read and write; 404 not 403 for other tenants; admin privileges on a separate boundary with step-up auth.

**Tenant isolation** — see §7. Plus: cross-tenant test suite in CI, RLS coverage check, no `org_id` from user input ever.

**API key security** — high-entropy, prefixed, stored hashed (SHA-256/HMAC), shown once, scoped, per-key rate limits, last-used tracking, instant revoke, rotation flow.

**Encryption** — TLS 1.2+ everywhere, HSTS; at rest via managed disk/DB encryption; **column-level envelope encryption for OAuth tokens, partner credentials, API secrets** using KMS with key rotation; encrypted backups with tested restores.

**Secrets management** — no secrets in git (scan for them in CI), platform secret store or Vault/KMS, distinct credentials per environment, short-lived credentials for CI, rotation runbook, no production secrets on developer laptops.

**Webhook verification** — HMAC over the **raw** body, constant-time compare, timestamp/replay window, reject unsigned, per-provider secret, log failures and alert on patterns. Our own outbound webhooks (if we offer them) must be signed the same way.

**Rate limiting & abuse** — per-IP and per-org limits on auth, uploads, exports, and public API; stricter on login/reset/signup; bot protection on signup; queue concurrency caps per org; upload size/count caps.

**Audit logs** — append-only, tamper-evident (hash chain if feasible), covering auth events, permission changes, integration connect/disconnect, credential access, label approvals, price and fee changes, refunds/credits, admin impersonation and cross-tenant reads, data exports. Retained per policy, queryable by support.

**Payment security** — hosted fields/Checkout (SAQ-A), no PAN/CVV ever in our systems or logs, webhook-verified payment state, amounts recomputed server-side, idempotency on charges, fraud signals on order velocity/mismatched pricing, 3DS where required.

**File upload security** — presigned uploads directly to private storage; validate magic bytes not extensions; enforce size/dimension limits; strip EXIF; **never serve user files from the app's own origin** (separate domain/bucket + `Content-Disposition`, no HTML/SVG execution — SVG is an XSS vector, sanitize or rasterize); malware scanning; no user-controlled storage paths; short-lived presigned reads.

**Application hardening** — parameterized queries/ORM only; output encoding; strict CSP; CSRF protection on cookie-authed mutations; SSRF protection on every user-supplied URL and on webhook/adapter callbacks (allowlist, block link-local/private ranges); dependency scanning and prompt patching; security headers; no stack traces to clients; structured logs with PII redaction.

**Operational** — least-privilege IAM, separate prod/staging with no shared credentials or data, no production data in dev (or robust anonymization), backup restore drills, incident response plan with a named owner, disclosure/security contact, access review cadence, offboarding checklist.

---

## 15. COMPLIANCE — areas requiring professional review

**This is not legal advice.** Each item below needs a qualified professional (regulatory counsel, a supplement/cosmetics compliance consultant, a customs broker, an accountant) before launch in each market. A private-label supplement platform is one of the more regulated ecommerce niches; underestimating this is the most likely way this business gets hurt.

Areas requiring review:
1. **Product legality per market** — which formulations may be sold where; ingredient permissibility and dose limits; novel-food/ingredient rules; differences between US (dietary supplements), EU/UK (food supplements), Canada (licensed natural health products), Australia (therapeutic goods), Gulf/Asia regimes.
2. **Labeling requirements** — mandatory panels, nutrient/supplement facts format, allergens, net quantity, country of origin, responsible-party name and address, batch/lot and expiry, language requirements, font/size minimums. Our label editor must *enforce* what counsel says is mandatory, so the rules must be known before the editor is designed.
3. **Health claims** — what a brand owner may write on a label, a product page, or an ad. This is the single highest-risk user-generated-content problem in the platform. Needs: a prohibited-claims policy, a review process, ToS liability allocation, and possibly automated screening.
4. **Who is the "responsible person" / manufacturer of record** — for supplements and cosmetics this is a formal role with legal duties (registration, adverse-event reporting, recalls). Is it us, the manufacturer, or the brand owner? Must be contractually explicit and reflected on labels.
5. **Facility & manufacturing standards** — GMP/cGMP, certifications, audit rights, COAs per batch, batch traceability from our order to a lot number (design the DB to record lot numbers if required).
6. **Recalls and adverse events** — who detects, who notifies, how we identify affected consumers across brands. This requires order↔lot traceability; retrofitting it is very hard.
7. **Cosmetics-specific** — different regimes entirely (e.g. EU CPNP notification, safety assessments, PIF).
8. **International shipping** — HS codes, customs documentation, restricted/prohibited items by country, import permits for supplements (many countries restrict), duties and de-minimis thresholds, IOSS/low-value regimes, who is importer of record, DDP vs DAP.
9. **Taxes** — sales tax/VAT/GST on our B2B charges and nexus/registration thresholds; the brand owner's own retail tax obligations; marketplace-facilitator rules (do they apply to us? probably not, but confirm); invoicing requirements per country; corporate structure.
10. **Consumer protection** — distance-selling and withdrawal rights in the EU/UK apply to *the brand owner*, but our policies constrain whether they can honor them. Mismatch is a legal trap for our users and a support burden for us.
11. **Returns/refunds law** — statutory rights vs our partner's practical refusal to accept returned consumables.
12. **Privacy/data protection** — GDPR/UK GDPR/CCPA: we are typically a **processor** for consumer data and a **controller** for brand-owner data. Needs: DPA with brand owners, DPAs with sub-processors, records of processing, lawful basis, retention schedule, deletion/redaction workflows (and Shopify's mandatory GDPR webhooks), international transfer mechanism, breach notification within statutory deadlines, cookie/consent on our marketing site.
13. **Advertising & platform policy** — Meta/Google/TikTok ad restrictions on supplements and health claims will materially affect our users' ability to sell; worth knowing before promising them growth.
14. **Contracts to be drafted** — brand-owner ToS (liability, claims, IP, cancellation cutoff, chargeback responsibility), AUP, privacy policy, DPA, manufacturer/supplier agreements (SLA, cost, MOQ, liability, insurance, IP in artwork, indemnity), 3PL agreement.
15. **Intellectual property** — brand owners uploading trademarked logos they don't own; a takedown/dispute process; our right to reproduce their artwork; who owns mockups and label files.
16. **Insurance** — product liability, professional indemnity, cyber. Also whether the manufacturer's policy names us as additional insured.
17. **Age/eligibility restrictions** on certain products; prohibited-category list for our catalog.

*Founder input, default taken in §18:* Launch market(s) — determines nearly all of the above.
*Founder input, default taken in §18:* Who is the responsible person/manufacturer of record?
*Founder input, default taken in §18:* Which professional advisors are being engaged, and by when?

---

## 16. MVP SCOPE

Goal of MVP: **one real brand owner ships one real order to one real consumer, with money collected and no manual heroics that don't scale past 20 orders/day.** Everything else is decoration.

### MUST HAVE
1. Email/password + OAuth signup, email verification, password reset, session management.
2. Organization + single brand, basic settings, one role (owner) + invite as stretch.
3. Curated catalog (**admin-managed, small — 10–30 SKUs**) with cost, spec, weight, lead time, label template.
4. Catalog browse + product detail with margin calculator.
5. Add product to brand → BrandProduct with retail price.
6. Label creation: logo upload + template-based editor with locked mandatory panels + server-rendered preview + print-ready file generation.
7. Admin label approval queue (manual — do not automate this yet).
8. At least two standard mockup images generated per product.
9. Shopify OAuth connect (one store per brand), publish product with mockups + price + SKU, store the sync mapping.
10. Order ingest: verified webhook + raw event persistence + dedupe + **reconciliation polling**.
11. Line-item resolution to SKU with an explicit `needs_review` path.
12. **Pricing + ledger, no processor**: server-side order pricing from a versioned fee schedule; `Charge` rows recorded per order against an internal ledger; `PaymentProvider` interface with a `manual` implementation; admin marks paid, audited. *(No live processor in v1 — see §0.1.)*
13. **Spreadsheet fulfillment dispatch behind the `FulfillmentProvider` interface**: batch export (CSV/XLSX) of ready orders with partner SKU codes, quantities, addresses and artwork links; `DispatchBatch` records; idempotency keys recorded before export.
14. **Spreadsheet return path**: idempotent import of the partner's completed sheet (status, tracking number, carrier) matched on our order reference, with a clear report of unmatched or malformed rows; plus manual entry in admin. Push fulfillment + tracking back to Shopify automatically.
15. Brand-facing order list/detail with status timeline and tracking.
16. Transactional emails: order received, payment failed, label approved/rejected, order shipped, action required.
17. Admin: work queue, order search + detail with raw payloads and manual retry/resolve actions, catalog CRUD, org list with suspend.
18. Multi-tenant isolation: org scoping + RLS + cross-tenant test suite.
19. Background jobs with retries, DLQ, and a stuck-entity alert.
20. Audit log for auth, integrations, label approvals, admin actions, money.
21. Error tracking, uptime monitoring, backups with a tested restore, staging environment.
22. Legal pages and ToS in place (drafted by counsel, not by us).

### SHOULD HAVE (soon after launch, not before)
- Team members + roles; multiple brands per org.
- Wallet/prepaid balance and auto-top-up.
- Sample orders.
- WooCommerce integration; "link my existing store product" import.
- Live shipping-rate quotes; multiple service levels.
- Inventory sync + stockout handling; restock notifications.
- Claims flow (damaged/lost/wrong item) with credit notes.
- Cancellation before cutoff, self-service.
- Brand analytics: orders, revenue, margin, best sellers.
- Invoices/statements PDF, billing history.
- Bulk label/product operations; duplicate a design across SKUs.
- Partner portal for a manufacturer to update statuses without our staff.
- Self-service address correction on held orders.
- In-app support/help center.

### LATER
- Additional manufacturers and multi-region routing; automated cheapest/fastest routing.
- Amazon/TikTok Shop/Etsy/BigCommerce/custom-store channels; a public API + our own outbound webhooks.
- 3D/AR mockups, AI-assisted label design, AI brand naming.
- Stocked/pre-purchased inventory mode with storage billing.
- Custom formulation workflow; custom packaging; inserts and marketing material.
- Subscription/recurring consumer orders (churn-critical for supplements — high value, meaningful complexity).
- Double-entry ledger, revenue recognition, automated partner-invoice reconciliation.
- Net-terms credit, financing.
- Warehouse/lot traceability, COA distribution, recall tooling (may be pulled forward by compliance).
- Data warehouse + BI; cohort and margin analytics.
- Own storefront builder (only if the strategy changes).
- White-label/reseller/agency accounts, marketplace of designers.

### DO NOT BUILD YET
- Own payment processing, wallets holding consumer funds, or split payouts.
- Own storefront/checkout, or being merchant of record for consumers.
- Microservices, Kubernetes, event streaming, GraphQL federation, multi-region.
- Custom 3D renderer or in-house design tool beyond the constrained editor.
- Mobile apps.
- Hand-rolled auth, permissions framework, or job queue.
- Multi-currency retail pricing engine, automated FX.
- Cross-tenant data/insight products.
- A generic "connect any manufacturer" self-serve integration builder.
- Automated compliance/claims checking presented as authoritative.
- AI features that touch money, labels, or compliance decisions unsupervised.

---

## 17. DEVELOPMENT ROADMAP

Assumes one full-time developer. Durations are relative effort, not promises, and depend on how many §18 defaults are resolved.

### Phase 0 — Foundations & decisions (before code)
**Objective:** remove ambiguity; stand up the skeleton.
- Answer Section 18 questions; sign at least one manufacturer with documented costs and capabilities.
- Decide charge model, fee schedule, launch market, label-approval policy.
- **DB:** none. **Backend:** repo, TypeScript config, CI, lint, formatting, env management, secret store, error tracking, staging + prod environments, IaC or platform config, migration tooling.
- **Frontend:** design system choice, component library, app shell.
- **Testing:** test harness, factories, one E2E smoke test in CI.
- **Deployment:** preview deployments, prod deploy on main, backups configured and a restore verified.
- Exit criteria: "hello world" deploys to prod through CI; secrets, logging, and backups work.

### Phase 1 — Tenancy, auth, catalog
**Objective:** a brand owner can sign up and browse products.
- **DB:** User, Organization, Membership, Invitation, AuditLog, Brand, Category, CatalogProduct, SKU, SkuCost, Asset, Supplier, Manufacturer, FulfillmentCenter. RLS policies + tenant-scoped data layer.
- **Backend:** auth integration, org provisioning, RBAC skeleton, tenant context middleware, catalog read API, admin catalog CRUD, asset upload with presigned URLs and validation.
- **Frontend:** signup/login/reset, onboarding, brand creation, catalog browse/detail with margin calculator, settings; admin shell + catalog CRUD.
- **Integrations:** auth provider, object storage, email.
- **Testing:** cross-tenant isolation suite (must exist from here on), auth flows, RLS tests.
- **Deployment:** staging with seeded demo catalog.

### Phase 2 — Branding & label pipeline
**Objective:** a printable, approved label and sellable mockups exist.
- **DB:** LabelTemplate, Label (versioned), BrandProduct, BrandProductVariant, Task/ReviewQueueItem.
- **Backend:** template/print-spec model, design-document persistence, server-side render → preview, mockup compositing job, print-file (PDF/X) generation, approval state machine, review queue, notifications.
- **Frontend:** label editor (constrained canvas, locked panels, safe-area guides), logo upload, preview, mockup gallery, submit-for-approval; admin review UI with reject reasons.
- **Integrations:** rendering library/headless browser; image pipeline.
- **Testing:** print-spec correctness (dimensions, bleed, DPI, color), version immutability, render snapshot tests, upload security tests.
- **Deployment:** background worker for renders; storage lifecycle rules.

### Phase 3 — Store integration & publishing
**Objective:** products live on a real Shopify store; orders arrive.
- **DB:** Integration, Store, ProductSyncMapping, WebhookEvent, OutboxEvent, Order, OrderItem, OrderEvent, Customer.
- **Backend:** provider interface + Shopify adapter (OAuth, encrypted tokens, scopes, webhook registration), product push, webhook ingress with HMAC verification and fast-200, idempotent ingest, order import + line resolution, reconciliation poller, uninstall/reauth handling, order state machine.
- **Frontend:** connect-store flow, publish/unpublish, sync status and errors, order list/detail with timeline; admin integration health.
- **Integrations:** Shopify (dev store for testing).
- **Testing:** signature verification, duplicate/out-of-order/lossy webhook scenarios, SKU-drift and unmapped-line cases, reconnect gap recovery.
- **Deployment:** webhook endpoint with generous capacity; queue monitoring; replay tooling.

### Phase 4 — Pricing & ledger *(no processor in v1)*
**Objective:** every order carries correct, auditable money, and the provider seam is ready.
- **DB:** Plan, fee-schedule versions, Charge (`pending_external`), ledger entries, CreditNote, per-org balance.
- **Backend:** versioned fee schedule, server-side pricing at order import, ledger with balance invariants, `PaymentProvider` interface + `manual` implementation, admin mark-paid/mark-unpaid with audit, CSV export of billable orders for offline invoicing.
- **Frontend:** per-order cost breakdown and a running statement for brand owners; admin billing queue.
- **Testing:** pricing correctness against the pinned fee-schedule version, ledger invariants, concurrency on charge creation.
- **Deferred to Phase 4b:** everything that talks to a processor.

### Phase 4b — Live payments *(unblocked when a §18 default is answered)*
**Objective:** we get paid automatically, without double-charging.
- **DB:** Plan, Subscription, PaymentMethod, Charge, WalletTransaction (if chosen), Invoice/InvoiceLine, CreditNote, Refund, fee-schedule versions.
- **Backend:** Stripe customer/payment-method setup, subscription lifecycle, server-side order pricing from the versioned fee schedule, off-session charge with deterministic idempotency, SCA action-required flow, webhook-driven reconciliation, dunning schedule, suspension rules, internal ledger.
- **Frontend:** plan selection & checkout, payment methods, billing history, invoices, dunning banners, action-required screen.
- **Integrations:** Stripe (+ tax if applicable).
- **Testing:** decline codes, SCA, retries, idempotency under concurrency, refunds/credits, reconciliation against the processor's test data.
- **Deployment:** separate webhook route, alerting on failed charges and dunning backlog.

### Phase 5 — Fulfillment & shipping *(spreadsheet adapter first)*
**Objective:** orders actually get made and shipped, and the store/consumer knows — via a spreadsheet, through the same interface an API will later use.
- **DB:** FulfillmentOrder, Shipment, ShipmentItem, TrackingEvent, Inventory, PartnerSkuMapping, Claim (basic).
- **Backend:** FulfillmentService + routing rules, **spreadsheet adapter (export batch / import results)** behind the `FulfillmentProvider` interface, DispatchBatch, idempotency keys, status normalization table, artwork delivery via presigned links in the sheet, tracking ingest, push fulfillment+tracking to Shopify, reconciliation of open orders against the last returned sheet, stuck-order monitor. Retries/DLQ/circuit breaker are built into the job layer now; a partner's REST client and its resubmission logic land in Phase 5b.
- **Frontend:** order status/tracking for brand owners, holds with clear actions; admin fulfillment console with retry/resubmit/manual-ship.
- **Integrations:** manufacturer/3PL; optional carrier tracking provider.
- **Testing:** duplicate-export and duplicate-import scenarios (must never double-manufacture or double-ship), unmatched and malformed rows, partial fulfillment, cancellation cutoff, out-of-order status events, and **adapter contract tests written against the interface, so a future API adapter inherits them unchanged**.
- **Deployment:** worker scaling, per-partner rate limits, on-call alerting.

### Phase 6 — Hardening & launch readiness
**Objective:** operate it safely with two people.
- Security review (checklist in §14), pen-test or at minimum an external review of auth/tenancy/uploads/webhooks.
- Load test webhook ingress and job throughput at 10× expected volume.
- Runbooks: partner API down, payment provider incident, webhook backlog, bad deploy rollback, data-restore drill, security incident.
- Observability: dashboards for order funnel, failures by stage, queue depth, adapter latency; alert thresholds tuned to avoid fatigue.
- Support tooling: impersonation (audited), canned actions, help docs.
- Legal pages live; DPA and sub-processor list published; GDPR deletion workflow implemented.
- Closed beta with 3–10 friendly brands; measure orders stuck, manual interventions per 100 orders, and margin variance. **Do not open publicly until manual interventions per 100 orders is low enough that two people can absorb 10× volume.**

### Phase 7+ — Growth
Second manufacturer (proves the abstraction), WooCommerce, wallet, claims/returns, analytics, team roles, subscriptions for consumers, public API.

---

## 18. DECISIONS ALREADY TAKEN (defaults)

Earlier drafts of this document raised 57 business questions and 47 open decisions. Most of them do not block writing code — they block *launching*, which is a different date. This section takes a working default for each so development can proceed, and records what it would cost to change the default later. Sections marked **cheap** can be changed by editing configuration or content; **medium** means a migration; **expensive** means a partial rewrite, and those are the only ones worth arguing about now.

| Area | Default taken | Cost to change |
|---|---|---|
| Merchant of record | Brand's own store collects consumer payment; we bill the brand | **Expensive** — confirmed with founders, not revisited |
| Product modes | Model supports **both** on-demand (label-at-pick) and stocked (we or the brand hold labeled units) from day one; `CatalogProduct.mode` + `Inventory` rows exist even if only one is used | **Expensive** if omitted — so it is not omitted |
| Fulfillment dispatch | Spreadsheet adapter behind `FulfillmentProvider` (§0.1) | Cheap — add an adapter |
| Payments | No processor; pricing + ledger + `manual` provider (§0.1) | Cheap — implement the interface |
| Catalog visibility | Requires signup; wholesale cost visible once signed in | Cheap |
| Free tier | None. Free signup, paid before publishing to a store | Cheap |
| Brands per org | Many. `Organization 1—* Brand` from the first migration | Expensive if omitted — so it is not omitted |
| Label approval | Manual, by us, through an admin queue. Auto-approval is never the default | Cheap |
| Claims liability | Brand owner is responsible for label content; our ToS says so; we review for print-readiness and obvious red flags only | Cheap in code, needs counsel before launch |
| Retail price floor | Warn below cost, never block | Cheap |
| Billing currency | Single currency per organization, configurable, one value at launch | Medium — but money is stored as minor units + currency code everywhere, so the schema already carries it |
| Money representation | Integer minor units + ISO currency code on every amount | Expensive if wrong — so it is fixed now |
| Fee schedule | Versioned config: unit cost + fulfillment fee + shipping + platform markup; values are data, entered later | Cheap |
| Shipping pricing | Flat table by destination zone, editable; live carrier rates later | Cheap |
| Addresses | International format stored as a snapshot on the order, never normalized into a shared address book | Medium |
| Label regime | Mandatory vs editable panels are **per-template data**, not code, so a jurisdiction's rules are content a compliance reviewer fills in | Cheap by design — this is why it is not a blocker |
| Artwork ownership | Brand owner owns their artwork; we keep a licence to reproduce it for fulfillment; files are exportable on account closure | Cheap |
| Manufacturer visibility | Hidden from brand owners by default | Cheap |
| Returns | No physical returns in v1. Consumer refunds are the brand's business; our cost is sunk | Cheap |
| Claims | Damaged / lost / wrong-item recorded as a `Claim` with a credit note; policy values are config | Cheap |
| Consumer contact | Consumers never contact us; we support brand owners only | Cheap |
| Lot traceability | `Shipment` and `OrderItem` carry optional lot/batch fields from the first migration, unused until a manufacturer supplies them | **Expensive** to retrofit — so the columns exist now |
| Order cancellation | Allowed until an order enters a dispatch batch; after that, refused | Cheap |
| Support | In-app email to us; no live channel in v1 | Cheap |
| Tenancy | Shared schema, `org_id` everywhere, Postgres RLS | Expensive if wrong — so it is fixed now |

The pattern: anything whose cost is **expensive** has been decided in favour of the more general option, because generality is cheap to build and impossible to retrofit. Everything **cheap** has a placeholder value that the founders can overwrite at any point without touching code.

---

## 19. WHAT ACTUALLY BLOCKS THE BUILD

Six items. Everything else in this document has a working default.

### Needed before Phase 2 (the label editor)

**1. One real product with its real label print specification.**
Not a decision — an artifact from the outside world. We need a die-line or template from a bottle/pouch supplier or label printer: physical dimensions, bleed, safe area, required DPI, colour profile, and which panels are fixed (supplement facts, allergens, net quantity, responsible-party block) versus editable. Any label printer will supply this for a standard bottle size, so this does not depend on the manufacturer negotiation. **Without it the label editor is built against a guess, and the print pipeline — the deepest technical unknown in the project — cannot be prototyped.**

**2. The shape of the initial catalog: roughly how many products, and do they have variants?**
Not the final list — just whether a product is one SKU or several (flavours, sizes, counts). Single-SKU products and multi-variant products are different UI and different sync mappings to the store. A one-line answer is enough: *"about 15 products, most single-SKU, a few with 2–3 flavours."*

### Needed before Phase 3 (store integration)

**3. Shopify first, or does v1 also need to accept orders with no store connected?**
Default taken: Shopify OAuth plus manual order entry in admin, which we need for testing anyway. Confirm only if the first users will not be on Shopify.

**4. Billing currency at launch.**
One value. The schema carries currency on every amount regardless, so this is a configuration answer, not a design one.

### Needed before Phase 5 (fulfillment)

**5. If the manufacturer will not do label-at-pick and we hold stock ourselves — who owns those units?**
Two models, and they differ in the data: *platform-owned* (we buy bulk, brands draw from shared stock, we carry the inventory risk) or *brand-owned* (a brand pre-buys a run, we store their labeled units, they carry the risk). Default taken: **platform-owned**, with `BrandInventory` in the schema so brand-owned can be added later. Confirm before we write the inventory ledger.

**6. The dispatch cutoff.**
At what point is an order no longer cancellable or address-changeable? Default taken: **when it enters a dispatch batch**. Confirm, because it is what the ToS has to say.

### Everything else

Compliance (§15) is the exception to "defaults are fine." It does not block development — the label editor treats mandatory panels as per-template data precisely so a compliance reviewer can fill them in later — but it **does** block launch, and the lead time on regulatory counsel is measured in weeks. Start that conversation in parallel with Phase 1 rather than after Phase 6.

---


## 20. FINAL OUTPUT

### A. What we are actually building — one paragraph

We are building a multi-tenant B2B SaaS platform that lets an entrepreneur create a branded physical-product business with no inventory: they subscribe, pick base products from our curated manufacturer catalog, design a compliant label on those products, publish them to their own Shopify store with generated mockups and their own retail prices, and then — when a consumer buys — our platform automatically imports the order, charges the brand owner our wholesale cost plus fulfillment and shipping, dispatches a production order to the right manufacturer through a partner-agnostic fulfillment adapter, and pushes tracking back to the brand's store so the consumer is notified under the brand's name. Technically it is an order-orchestration and integration system with a design tool attached: the hard parts are not the UI but idempotent webhook ingestion, a reliable order state machine with human work queues for every failure, an abstraction that keeps us independent of any single manufacturer, strict tenant isolation, and getting paid by brand owners before we incur manufacturing cost. Commercially we make money on the spread between our negotiated unit cost and what we charge the brand, plus subscriptions and fulfillment fees; we never touch the consumer's money.

### B. System architecture diagram (text)

```
 CONSUMER
    │ buys at retail price
    ▼
┌──────────────────────────┐        money stays with the brand owner
│ BRAND OWNER'S STORE      │───▶ brand's payment processor ──▶ brand's bank
│ (Shopify / Woo)          │
└─────────┬────────────────┘
          │ webhook: orders/paid, orders/cancelled, refunds/create …
          │                                   ▲
          │                                   │ fulfillment + tracking push
          ▼                                   │
┌─────────────────────────────────────────────┴────────────────────────────┐
│                            OUR PLATFORM                                  │
│                                                                          │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────────────┐    │
│  │ Brand App    │   │ Admin App    │   │ Webhook Ingress (fast 200) │    │
│  │ Next.js      │   │ (same repo,  │   │  HMAC verify → persist raw │    │
│  │ catalog,     │   │  separate    │   │  → dedupe → enqueue        │    │
│  │ label editor,│   │  authz+MFA)  │   └──────────────┬─────────────┘    │
│  │ orders,      │   │ queues,      │                  │                  │
│  │ billing      │   │ catalog, ops │                  │                  │
│  └──────┬───────┘   └──────┬───────┘                  │                  │
│         │                  │                          │                  │
│  ┌──────▼──────────────────▼──────────────────────────▼──────────────┐   │
│  │                  APPLICATION (modular monolith)                    │   │
│  │  auth/tenancy │ catalog │ branding+label │ integrations            │   │
│  │  orders (state machine + OrderEvent) │ fulfillment (router)        │   │
│  │  billing (ledger) │ notifications │ admin/ops │ audit              │   │
│  └───┬────────┬─────────┬──────────┬──────────┬─────────┬────────────┘   │
│      │        │         │          │          │         │                │
│  ┌───▼────┐ ┌─▼──────┐ ┌▼───────┐ ┌▼───────┐ ┌▼──────┐ ┌▼────────────┐  │
│  │Postgres│ │Outbox +│ │Object  │ │Render  │ │Email  │ │Observability│  │
│  │+ RLS   │ │Job     │ │storage │ │workers │ │/SMS   │ │Sentry, logs,│  │
│  │        │ │queue + │ │(S3/R2) │ │(label, │ │       │ │metrics,     │  │
│  │        │ │cron    │ │+ CDN   │ │mockup) │ │       │ │uptime       │  │
│  └────────┘ └───┬────┘ └────────┘ └────────┘ └───────┘ └─────────────┘  │
└──────────────────┼───────────────────────────────────────────────────────┘
                   │
      ┌────────────┼───────────────┬──────────────────┬──────────────────┐
      ▼            ▼               ▼                  ▼                  ▼
┌───────────┐ ┌──────────┐ ┌───────────────┐ ┌───────────────┐ ┌──────────────┐
│ Ecommerce │ │ Payments │ │ Fulfillment   │ │ Fulfillment   │ │ Carrier /    │
│ adapter   │ │ (Stripe) │ │ adapter: API  │ │ adapter:      │ │ tracking     │
│ Shopify   │ │ charges  │ │ Manufacturer A│ │ CSV/SFTP/email│ │ ingest       │
│ (Woo…)    │ │ brands   │ │               │ │ Manufacturer B│ │              │
└───────────┘ └──────────┘ └───────┬───────┘ └───────┬───────┘ └──────┬───────┘
                                   │                 │                │
                                   ▼                 ▼                │
                          ┌──────────────────────────────────┐        │
                          │ MANUFACTURER / FULFILLMENT CENTER│        │
                          │ bulk stock → label → pack → ship │────────┘
                          └───────────────┬──────────────────┘
                                          │ parcel, blind-shipped
                                          ▼
                                      CONSUMER

 Cross-cutting: tenant context (org_id) on every request/job/row · RLS ·
 idempotency keys in and out · retries + DLQ + circuit breakers ·
 reconciliation jobs against every external system · audit log · human work queues.
```

### C. MVP feature list
Auth & orgs · single brand · admin-curated catalog (10–30 SKUs) with costs and margin calculator · add product to brand + retail pricing · logo upload · template label editor with locked mandatory panels · server-rendered preview · print-ready file generation · manual label approval queue · generated mockups · Shopify OAuth connect · product publish + sync mapping · verified idempotent order ingest + reconciliation polling · line-item resolution with needs-review path · Stripe subscription + per-order off-session charging with dunning · fulfillment submission via manual/CSV adapter behind the provider interface (+1 API adapter if available) · fulfillment/tracking ingest · fulfillment + tracking push back to Shopify · brand order list/detail with timeline · transactional emails · admin work queue + order console with manual retry/resolve · catalog CRUD · org suspend · tenant isolation with RLS + cross-tenant tests · background jobs with retries/DLQ/stuck-order alerts · audit log · Sentry + uptime + backups with tested restore · staging · legal pages.

### D. Database entity list
**Tenancy/identity:** User, Organization, Membership, Invitation, ApiKey, AuditLog
**Brand/catalog:** Brand, Supplier, Manufacturer, FulfillmentCenter, Category, CatalogProduct, SKU (CatalogVariant), SkuCost, LabelTemplate, Asset
**Brand products:** BrandProduct, BrandProductVariant, Label (versioned)
**Integrations:** Integration, Store, ProductSyncMapping, WebhookEvent, OutboxEvent
**Orders/fulfillment:** Customer, Order, OrderItem, OrderEvent, FulfillmentOrder, Shipment, ShipmentItem, TrackingEvent, Inventory, InventoryLedger, PartnerSkuMapping, BrandInventory *(stocked mode)*
**Money:** Plan, Subscription, PaymentMethod, Charge/Payment, WalletTransaction, Invoice, InvoiceLine, CreditNote, Refund, Return, Claim
**Ops:** Notification, Task/ReviewQueueItem, FeatureFlag, Setting, IdempotencyKey
*MVP subset: drop BrandInventory, InventoryLedger, WalletTransaction, Return, ApiKey, FeatureFlag until needed.*

### E. API / service list
**Public/tenant API (or server actions):** auth, orgs & members, brands, catalog browse, brand products, labels (draft/submit/versions), assets (presigned upload), integrations (connect/disconnect/status), publishing, orders (list/detail/actions), billing (methods/plan/invoices), notifications, settings.
**Webhook endpoints:** `/webhooks/shopify`, `/webhooks/stripe`, `/webhooks/fulfillment/{partner}`, `/webhooks/carrier/{provider}` — all HMAC-verified, fast-200, idempotent.
**Internal services/modules:** TenancyService, CatalogService, LabelService (+ RenderWorker, PrintFileWorker, MockupWorker), IntegrationService (+ per-provider adapter), OrderService (state machine), PricingService (versioned fee schedule), BillingService (+ ledger, dunning), FulfillmentService (+ router + per-partner adapters), ShippingService/TrackingService, NotificationService, AuditService, AdminService, ReconciliationJobs (orders, fulfillments, charges, shipments), StuckEntityMonitor, OutboxPublisher.
**Admin API:** catalog CRUD, orgs/users, work queues, order console actions, payments/credits, integrations health, system health, webhook replay, audit search, feature flags.

### F. Third-party integrations required
**MVP:** Shopify (OAuth app + webhooks) · auth provider (Clerk/WorkOS/Auth0/Supabase Auth) · object storage (S3/R2) + CDN · transactional email (Resend/Postmark/SES) · job queue/scheduler (Inngest/Trigger.dev or Redis+BullMQ) · managed Postgres · error tracking (Sentry) · uptime monitoring · hosting/CI (Vercel/Render/Fly + GitHub Actions) · manufacturer/3PL API-or-CSV channel · rendering/imaging (sharp/ImageMagick/headless Chromium; PDF generation).
**Soon:** payment provider (Stripe unless justified otherwise — subscriptions, off-session charges, webhooks) · first manufacturer API adapter · address validation (Google/Loqate/EasyPost) · carrier tracking aggregator (EasyPost/Shippo/AfterShip) · tax (Stripe Tax/Avalara) · WooCommerce · support desk (Intercom/Crisp) · product analytics (PostHog) · virus scanning · SMS (Twilio) · accounting sync (QuickBooks/Xero).
**Later:** additional manufacturers, Amazon/TikTok/Etsy channels, search engine (Meilisearch/Typesense), warehouse/data BI, mockup/3D vendor, KYC/fraud tooling if the payment model changes.

### G. What the commercial founder still owns
Two answers before Phase 2 (one real label print spec, the rough catalog shape), two before Phase 5 (stock ownership if we hold inventory, the dispatch cutoff), and one parallel track that does not block code but does block launch: engaging regulatory counsel for the launch market. Everything else in §18 has a default they can overwrite at any time by editing configuration, not by asking for a rebuild.

### H. What the technical founder must decide
Framework and runtime; ORM and how it coexists with Postgres RLS; managed vs self-hosted auth; the job/queue platform; hosting region; **where the label renderer lives and what produces print-grade PDF/X — the deepest unknown, to be prototyped before Phase 2 is estimated**; mockup generation in-house or vendor; credential encryption and rotation; secret handling for a solo developer; the testing split and how adapters are faked; what to alert on; migration and rollback discipline; backup RPO/RTO; and whether to pursue a Shopify app-store listing at launch or stay a private app.

---

## Closing note on sequencing

The two highest-risk items are not code:

1. **A manufacturer that can genuinely label-at-pick single units, blind-shipped, at a workable cost.** If that partner does not exist on acceptable terms, the product cannot work as described, regardless of how good the software is. Validate this first.
2. **The label print pipeline.** Turning a browser design into a print-accepted PDF/X that a manufacturer's prepress will pass without manual rework is the deepest technical unknown here. Prototype it against the real partner's spec before committing to any timeline.

Everything else in this document is well-understood engineering. Those two are the ones that decide whether the business exists.
