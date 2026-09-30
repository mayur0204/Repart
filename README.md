# RePart

A marketplace for used motorcycle and scooter parts in India: listings are risk-screened, parts can get a Partner Check from a garage mechanic, payment is held until the buyer confirms the part is OK. The product brief is `REPART_BRIEF.md` and the build plan is `PLAN.md`. All data shipped with the app is clearly marked SAMPLE data.

> **Production safety.** Nothing in this repository creates, migrates, seeds or tests a production database. Development uses the Supabase **development** project; automated tests use a local Postgres container only and refuse any other database (`tests/setup/assert-test-db.ts`). The seed refuses `NODE_ENV=production`. Cashfree is **sandbox only**: `CASHFREE_ENV` accepts nothing but `sandbox`, and `PAYMENT_PROVIDER=mock` is refused in production.

## Stack

- Next.js (App Router, `proxy.ts`), React, TypeScript strict, Tailwind CSS (CSS-first theme in `app/globals.css`)
- Prisma with Postgres. Supabase for the development database and file storage (server-side only; no Supabase Auth, the browser never talks to the database)
- BullMQ on Redis for background work, fed by a transactional outbox
- Vitest (unit + integration) and Playwright + axe (end to end)

## Prerequisites

- Node 22.12 or newer
- Docker (Redis and the local test Postgres; optionally MinIO)
- A Supabase **development** project (Mumbai region) for local development

## Setup

```sh
npm install                 # also runs prisma generate
cp .env.example .env        # fill in values; .env is git-ignored and must never be committed
npm run services:up         # Redis + local test Postgres (docker compose)
```

`.env.example` lists every variable by name with a comment. `src/server/env-schema.ts` validates them the first time the server reads its config and refuses to start if one is missing or malformed. Secret-looking names must never use the `NEXT_PUBLIC_` prefix; the server refuses to start and a unit test fails if one does.

A pre-commit hook refuses `.env*` files (except `.env.example`), key files and key-like strings: `git config core.hooksPath .githooks`.

### Supabase development project

1. Create a project in the Mumbai region. Copy the pooled connection string to `DATABASE_URL`, the direct connection string to `DIRECT_URL`, the project URL to `SUPABASE_URL` and the service-role key to `SUPABASE_SERVICE_ROLE_KEY` (server-side only; it is never sent to the browser).
2. Create four **private** storage buckets: `listing-photos`, `inspection-photos`, `dispute-evidence`, `catalogue-imports` (names can be changed with the `STORAGE_BUCKET_*` variables). Add a lifecycle rule that deletes objects under `incoming/` older than 24 hours: uploads land there and are deleted once processed, so anything left is an abandoned upload.
3. Apply migrations and seed SAMPLE data:

```sh
npm run db:migrate                      # prisma migrate deploy, using DIRECT_URL
npx tsx prisma/seed/seed.ts --target=dev   # idempotent; only touches isSample rows
```

Migrations enable row-level security on every table with no policies and revoke `anon`/`authenticated` access, so the public Supabase API can read nothing.

## Running

```sh
npm run dev        # web app on http://localhost:3000
npm run worker     # background worker (separate, long-running process)
```

The **worker** runs the BullMQ consumers, the outbox relay (every second) and its sweeper (re-sends anything undispatched after a minute), the order sweep (missed timers, settlement sync, hold-deadline breaches; every minute), the Partner Check label expiry and hold-deadline watch (hourly) and, with a real payment provider, daily reconciliation. If it is down, timers and deadline alerts stop, so production must run at least one instance with auto-restart. It shuts down gracefully on SIGTERM/SIGINT (finishes in-flight jobs, closes queues and the database).

| Route | What it is |
|---|---|
| `/api/health` | Checks the database, Redis and storage. Returns only `up`/`down` for each; 503 if any is down. Use it for uptime checks. |
| `/offline` | What the service worker shows when a page can't load offline. |
| `/manifest.webmanifest` | PWA manifest (192 and 512 PNG icons plus SVG). |
| `/dev/components`, `/dev/mock-checkout/...` | Development-only tools; 404 in production builds. |

### PWA and offline

The service worker (`public/sw.js`, production builds only) precaches the offline page and icons, caches build assets (their names carry content hashes) and keeps up to 25 recently viewed **public** pages (home, search, listings, part numbers, seller profiles, help pages) for reading offline. It never caches API routes, server actions, anything cross-origin (including signed photo URLs) or signed-in areas (orders, account, messages, selling, garage, checkout, mechanic, admin). The cache is emptied when the signed-in account changes. While offline a banner explains that nothing can be saved, bought or sent, and forms are disabled; there are no offline writes.

## Environment variables

| Variable | Notes |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | Supabase dev: pooled URL for the app, direct URL for migrations |
| `TEST_DATABASE_URL` | Local test Postgres only, e.g. `postgresql://repart:<password from docker-compose.yml>@127.0.0.1:54329/repart_test` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Storage (server-side). `SUPABASE_ANON_KEY` is listed but not read by the app (reserved for a manual RLS smoke test against the public API) |
| `STORAGE_PROVIDER` | `supabase` (default), `minio`, or `memory` (tests) |
| `STORAGE_BUCKET_*`, `MINIO_*` | Bucket names; MinIO endpoint and keys when `STORAGE_PROVIDER=minio` |
| `REDIS_URL` | Default `redis://127.0.0.1:6379` |
| `APP_BASE_URL`, `SESSION_SECRET` (32+ random characters), `LOG_LEVEL` | |
| `OTP_PROVIDER`, `PAYMENT_PROVIDER`, `SHIPPING_PROVIDER`, `VISION_PROVIDER`, `NOTIFICATION_PROVIDER` | Adapter choice; all default to `mock` |
| `MOCK_WEBHOOK_SECRET`, `SHIPPING_WEBHOOK_SECRET` | Secrets the mock payment provider and mock courier sign their webhooks with |
| `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_ENV` | Cashfree **sandbox** keys (set both or neither); `CASHFREE_ENV` must be `sandbox` |

## Providers: mocks and real implementations

Every external service sits behind an interface in `src/server/adapters/<service>/types.ts`, and `src/server/adapters/index.ts` picks the implementation from env. The whole app runs end to end with mocks.

| Adapter | Implementations |
|---|---|
| OTP | Mock: every code is `000000`; logs never show the full number. Reserved sample numbers (`55555…`) are refused by production builds. |
| Payment | Mock (signed webhooks, instant vendor onboarding) and **Cashfree Easy Split, sandbox** (`PAYMENT_PROVIDER=cashfree`) |
| Shipping | Mock courier: quotes by pincode distance band and weight; signed tracking webhooks |
| Vision | Deterministic mock keyed by image hash |
| Storage | Supabase Storage (default), MinIO, in-memory |
| Notification | Mock: records in-app messages, logs without contact details |

**Swapping in a real provider:** implement the interface in a new file next to the mock (for example `src/server/adapters/shipping/<name>.ts`), add its name to the provider's enum in `src/server/env-schema.ts` along with any keys it needs (server-only names, never `NEXT_PUBLIC_`), and select it in `src/server/adapters/index.ts`. Webhooks go through `app/api/webhooks/...` route handlers, which verify the signature over the raw body and a timestamp window before parsing anything, and store each provider event id once so duplicates are ignored. Add the provider's origins to `src/lib/security-headers.ts` if the browser has to load or call anything from it.

**Cashfree sandbox:** create a Cashfree test account, copy the sandbox App ID and Secret Key into `CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY`, set `PAYMENT_PROVIDER=cashfree`, and point the sandbox webhook at `<APP_BASE_URL>/api/webhooks/payments/cashfree`. The browser loads Cashfree's checkout script from `sdk.cashfree.com` and is sent to `sandbox.cashfree.com`; both are the only Cashfree origins the Content-Security-Policy allows. There is no production mode in this codebase.

## Security

- Sessions: random token in an `httpOnly`, `secure`, `sameSite=lax` cookie; only its SHA-256 hash is stored. Suspended users' sessions stop resolving immediately.
- Every server action and route handler is built with `defineAction` / `defineRoute` (role check, Zod input, rate limit); a unit test fails if one isn't.
- Rate limits (Redis, versioned in admin settings): OTP send per phone and per IP, OTP verify attempts, messages, listing submissions, interchange suggestions.
- Photos: uploaded to a private `incoming/` key through a signed URL (5 minutes), re-encoded with `sharp` (EXIF and GPS removed), and served only through signed download URLs that expire after 10 minutes.
- Headers: a per-request nonce Content-Security-Policy on every page (`proxy.ts`, `src/lib/security-headers.ts`), `default-src 'none'` on API responses, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` and HSTS (ignored by browsers on plain-HTTP localhost).
- Audit: the audit log is append-only (a database trigger rejects UPDATE and DELETE) and can be browsed read-only at `/admin/audit`.
- Logs: JSON (pino) with request, user and job ids; secrets, OTPs, bank fields and phone numbers are redacted.

## Tests

```sh
npm run typecheck
npm run lint
npm run lint:design       # static design-rule check (no rounded corners, shadows, gradients, ...)
npm test                  # unit tests
npm run test:integration  # needs `npm run services:up`; local test Postgres ONLY
npm run test:e2e          # Playwright + axe, both widths
npm run screenshots       # screenshot matrix only, to screenshots/<milestone>/ (git-ignored)
```

**End to end.** `npm run test:e2e` builds the app, starts `next start` on port 3100 and, in the global setup: checks `TEST_DATABASE_URL` is local, recreates and migrates the test database, seeds SAMPLE data, empties Redis database 1 (e2e only) and starts the worker, which it stops again at the end. The server and worker run with `NODE_ENV=test`, mock providers and fixed local webhook secrets (`tests/e2e/support/env.ts`); the build itself is a normal production build. Each journey runs at 375×812 and 1440×900 with axe (WCAG 2.1 AA). Seeded users sign in with a session created in the test database, because production builds refuse the reserved sample phone numbers; the sign-in journey itself uses the real form. Payments and courier updates arrive the way providers send them: as signed webhooks.

Set `E2E_REUSE_SERVER=1` to reuse an e2e server already running on port 3100, and `SCREENSHOT_MILESTONE` to change the screenshot folder (default `m13`).

**E2E storage.** Photo journeys (listing photos → worker processing → risk screening, Partner Check inspection photos, dispute evidence) use the real storage path: the app's Supabase adapter and the private buckets of the Supabase **development** project named by `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` in `.env`. The run fails at start, naming the missing variable, if either is unset. The service-role key stays in the server, the worker and the test runner; browsers only ever get signed upload and download URLs. Test photos are generated deterministically (`tests/e2e/support/images.ts`), and the global teardown deletes every object the run's test database refers to, and nothing else. Never point `.env` at a production project.

## Code map

| Path | Contents |
|---|---|
| `app/` | Routes only; they stay thin and call services. `error.tsx` and `not-found.tsx` are the shared error and not-found states. Loading skeletons (`loading.tsx`, one shared `PageSkeleton`) sit only above list and static pages: list pages that share a folder with record pages live in an `(index)` route group, so no skeleton is ever streamed above a record page and a missing record returns a real 404. |
| `proxy.ts` | Per-request CSP nonce and coarse sign-in redirects (no database access) |
| `src/components/` | UI: `ui/` base components, `layout/` (top bar, bottom bar, offline banner, service worker), feature folders |
| `src/lib/` | Code shared by browser and server: formatting, schemas, security headers |
| `src/server/adapters/` | External services (see above) |
| `src/server/services/` | All business logic. `order/state.ts` and `listing/state.ts` are the only writers of order and listing state; each change is validated, audited and emits outbox jobs in one transaction. |
| `src/server/jobs/`, `src/worker/` | Queue names, job payload schemas, BullMQ wiring, worker and handlers |
| `prisma/` | Schema, migrations, SAMPLE seed |
| `tests/` | `unit/`, `integration/` (local Postgres), `e2e/` (Playwright), `setup/` (database guard and helpers) |

## Deployment requirements (no provider chosen)

See `PLAN.md` §12. In short: a Node runtime (not edge) for the web app that passes webhook bodies through unmodified; a persistent worker process with auto-restart; persistent Redis over TCP with `noeviction`, TLS and auth; a separate Supabase production project (created by the owner) with `prisma migrate deploy` run once per release before new web and worker versions start; private buckets with the `incoming/` lifecycle rule; JSON logs shipped from web and worker; and **alerts on `/api/health` failures, worker downtime and queue backlog**. The app has no built-in alerting: set these up on the hosting platform (for example, alert when the worker process restarts repeatedly or when BullMQ's waiting count keeps growing).
