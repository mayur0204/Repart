# RePart

A marketplace for used motorcycle and scooter parts, checked and delivered. The product brief is in `REPART_BRIEF.md` and the build plan is in `PLAN.md`. This README covers milestone 1 (foundation).

## Stack

- Next.js (App Router), TypeScript strict, Tailwind CSS (CSS-first theme in `app/globals.css`)
- Prisma with Postgres. Supabase is the development database and storage. Tests use a local Postgres container only.
- BullMQ on Redis for background jobs, fed by a transactional outbox
- Vitest (unit + integration) and Playwright + axe (end to end)

## Prerequisites

- Node 22.12 or newer
- Docker (for Redis and the test Postgres)

## Setup

```sh
npm install                 # also runs prisma generate
cp .env.example .env        # then fill in values; .env is git-ignored
npm run services:up         # Redis + local test Postgres
```

`.env.example` lists every variable by name. `src/server/env-schema.ts` validates them when the server first reads its config, and the server refuses to start if one is missing or malformed. Secret-looking names must never use the `NEXT_PUBLIC_` prefix, and a test enforces this.

## Running

```sh
npm run dev        # web app on http://localhost:3000
npm run worker     # background worker: BullMQ consumers + outbox relay and sweeper
```

Useful routes in M1:

| Route | What it is |
|---|---|
| `/api/health` | Checks the database, Redis and storage. Returns only `up` / `down` for each (503 if any is down). |
| `/dev/components` | Gallery of the base components. Development only, 404 in production. |
| `/offline` | Page the service worker serves when a navigation fails offline. |
| `/manifest.webmanifest` | PWA manifest. |

The service worker (`public/sw.js`) only registers in production builds.

## Checks

```sh
npm run typecheck
npm run lint
npm run lint:design       # static design-rule check (no rounded corners, shadows, gradients, ...)
npm test                  # unit tests
npm run test:integration  # needs `npm run services:up`; runs against the local test Postgres ONLY
npm run test:e2e          # Playwright + axe
```

Integration tests and `db:test:reset` refuse to run unless `TEST_DATABASE_URL` points to a local host (`tests/setup/assert-test-db.ts`). They never touch Supabase.

## Code map

| Path | Contents |
|---|---|
| `app/` | Routes only. They stay thin and call services. |
| `src/components/ui/` | Base components: Button, Input, Select, OptionTileGroup, SegmentedControl, Dialog, Sheet, Toast, Tooltip, Skeleton, ProgressBar, Badge, Price, PartNumberText, DateText, Icon, EmptyState, ErrorState, OfflineState, PermissionDenied |
| `src/components/layout/` | TopBar (desktop search + nav), BottomBar (mobile nav), service worker registration |
| `src/lib/` | Code shared by browser and server: formatting (`formatPrice`, `formatDate`, `formatKm`), part-number normalisation |
| `src/server/adapters/` | One folder per external service (`otp`, `payment`, `shipping`, `vision`, `storage`, `notification`), each with `types.ts` and a mock. `index.ts` picks the implementation from env. |
| `src/server/services/audit/` | `recordAudit(tx, entry)`: an append-only audit row written in the caller's transaction. A database trigger rejects UPDATE and DELETE on it. |
| `src/server/services/outbox/` | `enqueueOutbox(tx, job)` writes side effects in the business transaction. `relayOutbox` pushes them to BullMQ with the outbox id as the job id. |
| `src/server/jobs/` | Queue names, job payload schemas (Zod) and BullMQ wiring |
| `src/worker/` | Worker entry point and job handlers |
| `prisma/` | Schema, migrations, SAMPLE seed data |

### Adapters

Every external service sits behind an interface with a mock implementation, so the app runs end to end with no third-party accounts.

| Adapter | M1 implementation |
|---|---|
| OTP | Mock. The code is always `000000`, and the logs never show the full phone number. |
| Payment | In-memory mock with signed fake webhooks. M8 makes it DB-backed and adds Cashfree Easy Split (sandbox). |
| Shipping | Deterministic mock. Quotes are based on pincode distance band and billable weight. |
| Vision | Deterministic mock keyed by image hash. Unknown images return zero confidence. |
| Storage | Supabase Storage (default), MinIO (`STORAGE_PROVIDER=minio`) or in-memory (`memory`, for tests). |
| Notification | Mock. It records and logs each message without contact details. |

### Side effects: the outbox

Services never call a provider or enqueue a job directly. They call `enqueueOutbox(tx, ...)` inside their transaction, so the job exists only if the business change commits. The worker relays pending rows every second, and a sweeper catches rows older than one minute. Handlers must be idempotent because delivery is at least once. To add a job:

1. Add its Zod payload schema to `src/server/jobs/queues.ts`.
2. Add a handler in `src/worker/handlers.ts`.

## Design rules

The brief's visual rules (no rounded corners, no decorative shadows, no gradients, no ALL-CAPS, no monospace, and so on) are enforced by `npm run lint:design` and by the rendered check in `tests/e2e/design-rules.spec.ts`. Icons come only from the `<Icon>` wrapper, and lint blocks importing `lucide-react` anywhere else.

## Not in M1 yet

- Supabase migration apply and seeding of the dev project
- Settings service + default settings version
- Service-worker app-shell caching, and disabling mutations while offline
- Sign-in, sessions and RBAC wrappers (`defineAction` / `defineRoute`): M2
