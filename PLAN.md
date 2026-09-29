# RePart: build plan

Status: **revision 2, awaiting approval.** No application code, database schema, migration or provider configuration has been created. The Prisma schema below is a design, not an applied migration.

Source of truth: `REPART_BRIEF.md`. Section references (§) point to it. Where this plan fills a gap in the brief, it is marked **[assumption A-n]** and listed in the assumptions register (§14.3). Owner decisions from the review of revision 1 are marked **[decision D-n]** (§14.1).

### Revision 2 changes (summary)
- **Platform fee (§7):** rewritten around one platform fee with an explicit ownership table, invariants and refund allocation. The owner's worked example actually charges the fee twice, so it is explained in §7.1 and one question remains (Q1).
- **Dispute deadline (§5.3):** removed the proposed automatic refund before the provider's auto-release. Replaced it with stored deadlines, escalating admin alerts and a breach procedure. The 45-day hold is a setting taken from the brief, to be verified in Cashfree docs at M8.
- **Sample data (§11):** fictional "Sample Motors" vehicles and a `SAMPLE-` part-number format, so seed data can't be read as real-world fitment.
- **Tests (§10):** local Postgres container for automated tests, with a guard that refuses to run tests against any non-local database.
- **Deployment (§12):** new section listing requirements for web, worker, Redis, database and storage without choosing a hosting provider.
- **Git and secrets (§9 M1, §1.2):** exact order: `git init` → `.gitignore` → secret check → first commit. Env validation and server-only guards added.
- **Local-pickup listings (§5.1, §7.2):** corrected a revision-1 proposal that went beyond the brief. The payout-account requirement to publish now applies to delivery listings only, as §3 says.
- **Consistency fixes:** Order `total` CHECK constraint made unconditional; `buyerVehicleId`/`fitPath` moved into the schema (they were only mentioned in prose); `SellerRecovery` model added for post-settlement refunds; RLS also covers `_prisma_migrations`; the questions list is split into decisions, open questions and assumptions.

---

## 1. Architecture overview

### 1.1 Shape

One repository, two deployable processes that share the same server code:

```
                ┌───────────────────────────── Next.js app (web) ─────────────────────────────┐
 browser ──────►│ app/ routes (RSC pages, server actions, route handlers)                      │
 (PWA)          │    │  thin: parse with Zod → requireRole → call a service → render/redirect  │
                │    ▼                                                                         │
                │ src/server/services/*   ← ALL business logic, state machines, money          │
                │    │            │                                                            │
                │    ▼            ▼                                                            │
                │  Prisma      src/server/adapters/* (Otp, Payment, Shipping, Vision,          │
                │  (pooled)      Storage, Notification) — interface + mock + real impls        │
                │    │            │                                                            │
                │    │            └── enqueue jobs (BullMQ) ──┐                                │
                └────┼────────────────────────────────────────┼────────────────────────────────┘
                     │                                        ▼
                     │                              Redis (Docker locally)
                     │                                        │
                ┌────┼───────────── worker (node, BullMQ) ────┼────────────────────────────────┐
                │    ▼                                        ▼                                │
                │  same services: photo processing, risk check, timers (seller confirm,        │
                │  acceptance window, payment TTL), notifications, saved-search alerts,        │
                │  daily Cashfree reconciliation, dispute-deadline watch                       │
                └──────────────────────────────────────────────────────────────────────────────┘
                     │
                     ▼
     Supabase (Mumbai, dev project): Postgres (RLS on, no policies) + private Storage buckets
```

### 1.2 Key decisions

| Concern | Decision |
|---|---|
| Framework | Next.js App Router, TypeScript `strict`, React Server Components by default; client components only for interactive pieces (wizard steps, gallery, filters, photo capture). |
| Business logic | `src/server/services/*`. Pages, server actions and route handlers never touch Prisma directly for writes; they call services. Enforced with an ESLint `no-restricted-imports` rule (`@/server/db` importable only from `src/server/**`). |
| Validation | Zod schema for every server action, route handler, webhook payload, job payload and CSV row. Shared schemas in `src/lib/schemas`. |
| RBAC | Single `defineAction({ input, roles, rateLimit }, handler)` and `defineRoute(...)` wrappers. Every action/handler must be built with one; a Vitest test walks `app/**` and fails if a server action or route handler file does not use a wrapper. Ownership checks (e.g. "is this your listing") live in the service. |
| Auth | Our own phone-OTP sign-in (no Supabase Auth, §2). `Session` table stores a SHA-256 hash of a random token; cookie is `httpOnly`, `secure`, `sameSite=lax`, 30-day rolling. Next.js middleware only does coarse redirects; real checks happen in the wrappers. |
| Data access | Prisma only, server-side only, against the Supabase **development** project (Mumbai) **[decision D-1]**. Runtime uses the Supabase pooler URL (`DATABASE_URL`, session or transaction mode; the Prisma settings each mode needs are confirmed in the Supabase/Prisma docs at M1). Migrations use `DIRECT_URL`. No Supabase Auth and no Supabase client for data access. `@supabase/supabase-js` is used only inside the Storage adapter, server-side, with the service-role key. RLS is enabled on every table in `public` (including `_prisma_migrations`) with zero policies, and `anon`/`authenticated` privileges are revoked. |
| Secrets | `.env` is never committed (see M1 git steps). `src/server/env.ts` parses all env vars with Zod at boot and fails fast. Every server module imports `server-only`, so importing one into a client component is a build error. Only `NEXT_PUBLIC_*` vars reach the browser, and a test fails if any var whose name matches `KEY|SECRET|TOKEN|PASSWORD|DATABASE|SERVICE_ROLE` is prefixed `NEXT_PUBLIC_`. The logger redacts secrets, OTPs, bank fields and phone numbers. A pre-commit script refuses to commit `.env*` files (except `.env.example`) or strings that look like keys. |
| Environments | Development: Supabase dev project + local Docker Redis/MinIO. Automated tests: local Postgres container only (§10). Production: a separate Supabase project that this plan never touches. No code path or script reads production credentials, and seed and test scripts refuse to run when `NODE_ENV=production`. |
| Money | Integer paise everywhere (`Int`, max ≈ ₹2.1 crore per row, ample for parts). Aggregates computed as `bigint`. Formatting via `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })`. |
| State changes | `orderStateService.transition(orderId, event, actor, payload)` and `listingStateService.transition(...)` are the only writers of `Order.state` / `Listing.status`. Each runs in a DB transaction with optimistic locking (`version` column), validates against a transition table, writes an `OrderEvent`/`ListingEvent` row and an `AuditLog` row, and writes `OutboxJob` rows for side effects (notifications, payment calls, timers). |
| Audit coverage | `AuditLog` (actor, action, entity, before/after, request id) is written in the same transaction for: every listing and order transition, every payment/refund/settlement call and webhook outcome, payout-account status changes, settings version create/activate, category/catalogue/interchange edits and CSV import applies, admin moderation (reports, listing review, user suspend, role grants), dispute evidence and resolution, mechanic assignment and inspection submit, deadline alerts and breaches, reconciliation resolution, and training-data exports (who exported what). The audit log is append-only: no update/delete service exists, and a DB trigger rejects UPDATE/DELETE on the table. |
| Side effects | Transactional outbox: side effects are written as `OutboxJob` rows inside the same transaction, then a relay pushes them to BullMQ after commit. A sweeper re-enqueues any row older than 1 minute that was not dispatched. This means a crash between commit and enqueue never loses a refund or notification. |
| Timers | Deadlines are stored as columns (`sellerConfirmBy`, `acceptanceEndsAt`, `paymentExpiresAt`, `autoReleaseAt`). BullMQ delayed jobs fire them; a 5-minute repeatable sweeper also scans for overdue rows so a lost Redis job never strands an order. Timer handlers are no-ops if the order has moved on. |
| Idempotency | `WebhookEvent (provider, providerEventId)` unique; handlers insert first and skip on conflict. Monetary calls (create order, refund, release) carry an idempotency key stored in `IdempotencyKey` and passed to the provider where supported. |
| Photos | Direct browser upload to a private `incoming/` prefix via signed upload URL. A worker job downloads it, re-encodes with `sharp` (drops all EXIF including GPS, applies orientation), computes dimensions, blur (variance of Laplacian), brightness, perceptual hash (DCT pHash, 64-bit), writes the clean file to its final key and deletes the original. Only processed files are ever served, via short-lived signed download URLs (default 10 min). |
| Real-time-ish UI | "Checking your listing" and message threads poll a small JSON route handler every 3 s with back-off (no Supabase Realtime, since the browser has no DB access). |
| PWA | Web app manifest + service worker (Serwist, to be confirmed against current Next.js docs at M1). App shell and last-viewed pages cached; an `/offline` page; mutations are disabled with a clear message when offline. |
| Logging | `pino` JSON logs with request id, user id (never phone), job id. `/api/health` checks DB, Redis and storage reachability. |
| Rate limiting | Redis sliding window (`rate-limiter-flexible`): OTP send (per phone and per IP), OTP verify attempts, messages, listing submission. |

### 1.3 External service adapters (§3)

Each lives in `src/server/adapters/<name>/` with `types.ts` (interface), `mock.ts`, and real implementations. `src/server/adapters/index.ts` picks the implementation from env (`PAYMENT_PROVIDER=mock|cashfree`, etc.). A lint rule forbids importing any provider SDK or provider base URL outside its adapter folder.

| Adapter | Interface (summary) | Implementations |
|---|---|---|
| `OtpProvider` | `send(phone)`, `verify(phone, code)` | Mock (fixed code `000000` in dev/test, logged to console). |
| `PaymentProvider` | `createVendor`, `getVendorStatus`, `createOrder(split)`, `getOrder`, `markSettlementEligible(orderId)`, `refund(orderId, amount, splitReversal)`, `getSettlements(dateRange)`, `verifyWebhook(rawBody, headers)`, `parseWebhook` | Mock (DB-backed fake provider with a fake checkout page and signed fake webhooks) → Cashfree Easy Split (sandbox only). |
| `ShippingProvider` | `checkServiceability(from, to)`, `quote(from, to, weight, dims)`, `bookPickup`, `cancel`, `bookReturn`, `verifyWebhook`, `parseTracking` | Mock (deterministic quotes by pincode distance band; admin "advance shipment" button in dev to simulate tracking events). |
| `VisionProvider` | `classifyCategory(image)`, `detectDamage(image)`, `ocr(image)` each with confidence + `modelVersion` | Mock (deterministic by image hash; seed images carry expected outputs). |
| `StorageProvider` | `createSignedUploadUrl`, `createSignedDownloadUrl`, `get`, `put`, `delete` | Supabase Storage (default), MinIO (offline dev), in-memory for unit tests. |
| `NotificationProvider` | `sms`, `email`, `inApp` | Mock SMS/email (logged + stored in `NotificationDelivery`), in-app writes `Notification` rows. |

---

## 2. Prisma schema

Notes:
- Prisma's current major version moves connection URLs out of `schema.prisma` into `prisma.config.ts` and uses a driver adapter at runtime. I will confirm this against the current Prisma and Supabase docs at M1. The intended wiring is **CLI/migrations → `DIRECT_URL`**, **runtime `PrismaClient` → `DATABASE_URL` (pooled)**. If the current version still uses `url`/`directUrl` in the datasource block, they go there instead.
- Things Prisma can't express go in hand-written SQL inside migrations: RLS enable + privilege revoke on every table, partial unique indexes, and CHECK constraints (listed after the schema).
- `isSample` marks all seed data so the UI can show a "Sample" badge and exports can exclude it.

```prisma
generator client {
  provider = "prisma-client-js" // confirm generator name/output for current Prisma at M1
}

datasource db {
  provider = "postgresql"
  // URLs configured in prisma.config.ts (DIRECT_URL for CLI) and via driver adapter (DATABASE_URL) at runtime
}

// ───────────────────────────── Enums ─────────────────────────────

enum Role { MEMBER MECHANIC ADMIN }
enum UserStatus { ACTIVE SUSPENDED DELETED }
enum VehicleType { MOTORCYCLE SCOOTER CAR }
enum InspectionTier { A_AUTOMATED B_CONDITIONAL C_ALWAYS }
enum ShippingRestriction { NONE FRAGILE OVERSIZE NOT_SHIPPABLE }
enum InterchangeType { EXACT_EQUIVALENT SUPERSEDED_BY FITS_WITH_MODIFICATION }
enum InterchangeSource { OEM_CATALOGUE BRAND_CROSS_REFERENCE MECHANIC_CONFIRMED ADMIN USER_SUBMITTED }
enum ReviewStatus { PENDING APPROVED REJECTED }
enum FitmentSource { PART_NUMBER_MATCH MECHANIC_CONFIRMED BUYER_CONFIRMED SELLER_DECLARED }
enum FitmentVerdict { FITS DOES_NOT_FIT } // [assumption] needed for the "Known not to fit" fit bar state
enum ConditionGrade { LIKE_NEW GOOD FAIR FOR_REPAIR }
enum ListingStatus { DRAFT SUBMITTED SCREENING CHANGES_REQUESTED REJECTED LIVE RESERVED SOLD WITHDRAWN }
enum WeightBand { UNDER_1KG KG_1_3 KG_3_7 KG_7_15 KG_15_30 OVER_30KG }
enum DimensionBand { SMALL MEDIUM LARGE OVERSIZE }
enum FulfilmentMode { DELIVERY LOCAL_PICKUP }
enum InspectionRequirement { NOT_NEEDED OPTIONAL REQUIRED }
enum TrustLabel { PARTNER_CHECK SCREENED SELLER_DECLARED }
enum RoutingDecision { CHANGES_REQUESTED LIVE REJECTED }
enum InspectionReason { TIER_C TIER_B_THRESHOLD HIGH_RISK BUYER_OPTIONAL AUDIT }
enum InspectionStatus { PENDING_SLOT SCHEDULED COMPLETED CANCELLED NO_SHOW }
enum InspectionOutcome { PASS PASS_WITH_NOTES FAIL }
enum OrderState {
  CREATED PAID_HELD AWAITING_SELLER
  INSPECTION_SCHEDULED INSPECTION_PASSED
  PICKUP_SCHEDULED IN_TRANSIT DELIVERED
  AWAITING_HANDOVER // [assumption] local-pickup equivalent of PICKUP_SCHEDULED..DELIVERED
  ACCEPTANCE_WINDOW COMPLETED
  DISPUTED RESOLVED_REFUND RESOLVED_RELEASE
  CANCELLED
}
enum ActorType { USER SYSTEM PROVIDER_WEBHOOK ADMIN MECHANIC }
enum PaymentStatus { CREATED PENDING SUCCESS FAILED EXPIRED }
enum VendorSettlementStatus { NOT_APPLICABLE HELD ELIGIBLE SETTLED REVERSED }
enum RefundStatus { REQUESTED PENDING SUCCESS FAILED }
enum PayoutOnboardingStatus { NOT_STARTED PENDING ACTIVE ACTION_REQUIRED REJECTED }
enum ShipmentDirection { FORWARD RETURN }
enum ShipmentStatus { QUOTED BOOKED PICKUP_SCHEDULED PICKED_UP IN_TRANSIT OUT_FOR_DELIVERY DELIVERED FAILED CANCELLED RETURNED_TO_ORIGIN }
enum DisputeReason { DOES_NOT_FIT NOT_AS_DESCRIBED DAMAGED_IN_TRANSIT NOT_RECEIVED OTHER }
enum DisputeStatus { OPEN AWAITING_SELLER UNDER_REVIEW RESOLVED_REFUND RESOLVED_RELEASE }
enum DisputeParty { BUYER SELLER ADMIN }
enum ReviewDirection { BUYER_TO_SELLER SELLER_TO_BUYER }
enum ReportTarget { LISTING USER MESSAGE }
enum ReportStatus { OPEN ACTIONED DISMISSED }
enum NotificationChannel { SMS EMAIL IN_APP }
enum OutboxStatus { PENDING DISPATCHED FAILED }
enum ImportKind { MAKES MODELS VARIANTS PART_NUMBERS INTERCHANGE FITMENTS }
enum ImportStatus { VALIDATING VALIDATED APPLIED FAILED }

// ───────────────────────────── Users and consent ─────────────────────────────

model User {
  id              String     @id @default(cuid())
  phone           String     @unique // E.164, e.g. +919800000000
  phoneVerifiedAt DateTime?
  name            String?
  email           String?
  roles           Role[]     @default([MEMBER])
  status          UserStatus @default(ACTIVE)
  isSample        Boolean    @default(false)
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  sessions        Session[]
  consents        ConsentRecord[]
  addresses       Address[]
  payoutAccount   PayoutAccount?
  garage          GarageVehicle[]
  listings        Listing[]          @relation("SellerListings")
  buyerOrders     Order[]            @relation("BuyerOrders")
  sellerOrders    Order[]            @relation("SellerOrders")
  mechanicStaff   MechanicStaff?
  savedListings   SavedListing[]
  savedSearches   SavedSearch[]
  notifications   Notification[]
  reviewsWritten  Review[]           @relation("ReviewAuthor")
  reviewsReceived Review[]           @relation("ReviewSubject")
  reportsFiled    Report[]           @relation("Reporter")
  reportsAgainst  Report[]           @relation("ReportedUser")
  buyerConversations  Conversation[] @relation("ConvBuyer")
  sellerConversations Conversation[] @relation("ConvSeller")
  messages        Message[]
}

model Session {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash  String   @unique
  expiresAt  DateTime
  lastSeenAt DateTime @default(now())
  userAgent  String?
  createdAt  DateTime @default(now())
  @@index([userId])
}

model OtpChallenge {
  id          String    @id @default(cuid())
  phone       String
  providerRef String?
  attempts    Int       @default(0)
  expiresAt   DateTime
  verifiedAt  DateTime?
  createdAt   DateTime  @default(now())
  @@index([phone, createdAt])
}

model ConsentRecord {
  id          String    @id @default(cuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  purpose     String    // e.g. ACCOUNT_AND_ORDERS, PHOTO_TRAINING_DATA, MARKETING_SMS
  version     String    // policy version shown, e.g. "2026-09-01"
  grantedAt   DateTime  @default(now())
  withdrawnAt DateTime?
  @@index([userId, purpose])
}

model Address {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  label     String?
  contactName  String
  contactPhone String
  line1     String
  line2     String?
  landmark  String?
  city      String
  state     String
  pincode   String   // 6 digits, validated
  isDefault Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([userId])
  @@index([pincode])
}

model PincodeGeo {
  pincode  String  @id
  district String?
  state    String?
  lat      Float
  lng      Float
  isSample Boolean @default(false)
}

model PayoutAccount {
  id               String                 @id @default(cuid())
  userId           String                 @unique
  user             User                   @relation(fields: [userId], references: [id], onDelete: Cascade)
  provider         String                 // "mock" | "cashfree"
  providerVendorId String?                @unique
  status           PayoutOnboardingStatus @default(NOT_STARTED)
  statusReason     String?
  statusCheckedAt  DateTime?
  createdAt        DateTime               @default(now())
  updatedAt        DateTime               @updatedAt
  // No bank details, ever.
}

// ───────────────────────────── Vehicle catalogue ─────────────────────────────

model VehicleMake {
  id       String         @id @default(cuid())
  name     String         @unique
  slug     String         @unique
  isSample Boolean        @default(false)
  models   VehicleModel[]
}

model VehicleModel {
  id          String           @id @default(cuid())
  makeId      String
  make        VehicleMake      @relation(fields: [makeId], references: [id])
  name        String
  slug        String
  vehicleType VehicleType
  isSample    Boolean          @default(false)
  variants    VehicleVariant[]
  @@unique([makeId, slug])
}

model VehicleVariant {
  id        String        @id @default(cuid())
  modelId   String
  model     VehicleModel  @relation(fields: [modelId], references: [id])
  name      String        // e.g. "Standard", "ABS"
  yearFrom  Int
  yearTo    Int?          // null = still in production
  engineCc  Int?
  isSample  Boolean       @default(false)
  garageEntries GarageVehicle[]
  fitments  Fitment[]
  @@unique([modelId, name, yearFrom])
}

model GarageVehicle {
  id        String         @id @default(cuid())
  userId    String
  user      User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  variantId String
  variant   VehicleVariant @relation(fields: [variantId], references: [id])
  year      Int
  nickname  String?
  isPrimary Boolean        @default(false) // partial unique index: one primary per user
  createdAt DateTime       @default(now())
  @@index([userId])
}

// ───────────────────────────── Categories ─────────────────────────────

model PartCategory {
  id                       String              @id @default(cuid())
  parentId                 String?
  parent                   PartCategory?       @relation("CategoryTree", fields: [parentId], references: [id])
  children                 PartCategory[]      @relation("CategoryTree")
  name                     String
  slug                     String              @unique
  sortOrder                Int                 @default(0)
  isSafetyCritical         Boolean             @default(false)
  inspectionTier           InspectionTier
  inspectionValueThreshold Int?                // paise; Tier B only
  optionalCheckFee         Int                 @default(0) // paise
  optionalCheckEnabled     Boolean             @default(true) // [assumption] needed for Tier A "if the admin enables it"
  shippingRestriction      ShippingRestriction @default(NONE)
  packagingGuide           String
  partNumberHint           String?
  conditionChecklist       Json                // [{id, question, weight, badAnswer: "YES"|"NO", blocksListing}]
  photoGuide               Json                // [{shotType, label, instructions, exampleImageKey, required}]
  updatedAt                DateTime            @updatedAt

  partNumbers PartNumber[]
  listings    Listing[]
}

// ───────────────────────────── Part numbers and fitment ─────────────────────────────

model PartNumber {
  id         String        @id @default(cuid())
  display    String        // as printed, e.g. "SMP-12 345"
  normalized String        // uppercase, spaces and dashes stripped: "SMP12345"
  brand      String
  isOem      Boolean
  categoryId String
  category   PartCategory  @relation(fields: [categoryId], references: [id])
  isSample   Boolean       @default(false)
  createdAt  DateTime      @default(now())

  linksAsA   InterchangeLink[] @relation("LinkA")
  linksAsB   InterchangeLink[] @relation("LinkB")
  fitments   Fitment[]
  listings   Listing[]
  @@unique([normalized, brand])
  @@index([normalized])
}

model InterchangeLink {
  id                String            @id @default(cuid())
  partNumberAId     String
  partNumberA       PartNumber        @relation("LinkA", fields: [partNumberAId], references: [id])
  partNumberBId     String
  partNumberB       PartNumber        @relation("LinkB", fields: [partNumberBId], references: [id])
  type              InterchangeType   // SUPERSEDED_BY reads "A is superseded by B"
  source            InterchangeSource
  status            ReviewStatus      @default(PENDING)
  confirmationCount Int               @default(0)
  flaggedCount      Int               @default(0)
  inReviewQueue     Boolean           @default(false)
  notes             String?           // CHECK: required when type = FITS_WITH_MODIFICATION
  submittedById     String?
  reviewedById      String?
  reviewedAt        DateTime?
  createdAt         DateTime          @default(now())
  @@unique([partNumberAId, partNumberBId, type])
  @@index([partNumberBId])
  @@index([status, inReviewQueue])
}

model Fitment {
  id                String         @id @default(cuid())
  partNumberId      String?
  partNumber        PartNumber?    @relation(fields: [partNumberId], references: [id])
  listingId         String?
  listing           Listing?       @relation(fields: [listingId], references: [id], onDelete: Cascade)
  variantId         String
  variant           VehicleVariant @relation(fields: [variantId], references: [id])
  source            FitmentSource
  verdict           FitmentVerdict @default(FITS)
  confirmationCount Int            @default(0)
  flaggedCount      Int            @default(0)
  inReviewQueue     Boolean        @default(false)
  notes             String?
  createdById       String?
  createdAt         DateTime       @default(now())
  // CHECK: exactly one of partNumberId / listingId is set
  @@index([variantId])
  @@index([partNumberId])
  @@index([listingId])
}

// ───────────────────────────── Listings ─────────────────────────────

model Listing {
  id                    String                @id @default(cuid())
  sellerId              String
  seller                User                  @relation("SellerListings", fields: [sellerId], references: [id])
  categoryId            String?
  category              PartCategory?         @relation(fields: [categoryId], references: [id])
  partNumberId          String?
  partNumber            PartNumber?           @relation(fields: [partNumberId], references: [id])
  partNumberEntered     String?               // what the seller typed (may not match a catalogue entry)
  partName              String?
  title                 String?
  description           String?               // stored masked; contact details replaced
  checklistAnswers      Json?                 // {questionId: "YES"|"NO"}
  conditionScore        Int?                  // 0–100 derived from weights
  conditionGrade        ConditionGrade?
  kmUsedApprox          Int?
  reasonForSale         String?
  pricePaise            Int?
  pickupAddressId       String?
  pickupPincode         String?
  weightBand            WeightBand?
  dimensionBand         DimensionBand?
  fulfilmentMode        FulfilmentMode        @default(DELIVERY)
  status                ListingStatus         @default(DRAFT)
  wizardStep            Int                   @default(1) // furthest valid step, 1–7
  inspectionRequirement InspectionRequirement?
  inspectionReason      InspectionReason?
  trustLabel            TrustLabel            @default(SELLER_DECLARED)
  latestRiskScore       Int?
  sellerMessage         String?               // mechanic notes / admin notes shown on CHANGES_REQUESTED
  isSample              Boolean               @default(false)
  version               Int                   @default(0)
  submittedAt           DateTime?
  liveAt                DateTime?
  soldAt                DateTime?
  createdAt             DateTime              @default(now())
  updatedAt             DateTime              @updatedAt

  photos          ListingPhoto[]
  fitments        Fitment[]
  riskAssessments RiskAssessment[]
  inspections     Inspection[]
  orders          Order[]
  events          ListingEvent[]
  conversations   Conversation[]
  savedBy         SavedListing[]
  reports         Report[]
  @@index([status, categoryId])
  @@index([sellerId, status])
  @@index([partNumberId])
  @@index([pickupPincode])
}

model ListingPhoto {
  id               String   @id @default(cuid())
  listingId        String
  listing          Listing  @relation(fields: [listingId], references: [id], onDelete: Cascade)
  shotType         String   // matches PartCategory.photoGuide[].shotType
  sortOrder        Int
  incomingKey      String?  // raw upload; deleted after processing
  storageKey       String?  // processed, EXIF-stripped file
  processedAt      DateTime?
  width            Int?
  height           Int?
  pHash            String?  // 16 hex chars (64-bit)
  blurScore        Float?   // variance of Laplacian
  brightnessScore  Float?   // mean luma 0–255
  createdAt        DateTime @default(now())
  @@index([listingId])
  @@index([pHash])
}

model ListingEvent {
  id         String         @id @default(cuid())
  listingId  String
  listing    Listing        @relation(fields: [listingId], references: [id], onDelete: Cascade)
  fromStatus ListingStatus?
  toStatus   ListingStatus
  event      String
  actorType  ActorType
  actorId    String?
  payload    Json?
  createdAt  DateTime       @default(now())
  @@index([listingId, createdAt])
}

// ───────────────────────────── Checks and inspections ─────────────────────────────

model RiskAssessment {
  id                    String                @id @default(cuid())
  listingId             String
  listing               Listing               @relation(fields: [listingId], references: [id], onDelete: Cascade)
  score                 Int                   // 0–100
  reasons               Json                  // [{code, message, severity: "HARD"|"SOFT"|"INFO", photoId?, step?}]
  checkResults          Json                  // {checkCode: {passed, value, threshold, skipped?}}
  hadHardFailure        Boolean
  ruleSetVersion        Int                   // = SettingsVersion.version used
  visionModelVersion    String?               // null when Stage 2 skipped
  routingDecision       RoutingDecision
  inspectionRequirement InspectionRequirement?
  inspectionReason      InspectionReason?
  trustLabel            TrustLabel?
  createdAt             DateTime              @default(now())
  @@index([listingId, createdAt])
}

model MechanicPartner {
  id               String   @id @default(cuid())
  garageName       String
  addressLine      String
  city             String
  state            String
  pincode          String
  servicePincodes  String[]
  active           Boolean  @default(true)
  capacityPerDay   Int      @default(4)
  feePerInspection Int      @default(0) // paise owed to the garage per job
  isSample         Boolean  @default(false)
  // quality stats (denormalised, recomputed nightly)
  inspectionsCompleted Int    @default(0)
  failRate             Float?
  disputeAfterPassRate Float?
  onTimeRate           Float?
  createdAt        DateTime @default(now())

  staff       MechanicStaff[]
  inspections Inspection[]
}

model MechanicStaff {
  id        String          @id @default(cuid())
  userId    String          @unique
  user      User            @relation(fields: [userId], references: [id])
  partnerId String
  partner   MechanicPartner @relation(fields: [partnerId], references: [id])
  active    Boolean         @default(true)
}

model Inspection {
  id               String             @id @default(cuid())
  listingId        String
  listing          Listing            @relation(fields: [listingId], references: [id])
  orderId          String?
  order            Order?             @relation(fields: [orderId], references: [id])
  partnerId        String
  partner          MechanicPartner    @relation(fields: [partnerId], references: [id])
  mechanicUserId   String?
  reason           InspectionReason
  status           InspectionStatus   @default(PENDING_SLOT)
  slotStart        DateTime?
  slotEnd          DateTime?
  locationAddress  Json?              // snapshot of seller pickup address
  checklistResults Json?              // {questionId: "YES"|"NO"}
  measuredValues   Json?              // [{key, label, value, unit}] e.g. pad thickness mm
  outcome          InspectionOutcome?
  notes            String?
  buyerFeePaise    Int                @default(0)
  completedAt      DateTime?
  createdAt        DateTime           @default(now())
  photos           InspectionPhoto[]
  @@index([partnerId, slotStart])
  @@index([listingId])
}

model InspectionPhoto {
  id           String     @id @default(cuid())
  inspectionId String
  inspection   Inspection @relation(fields: [inspectionId], references: [id], onDelete: Cascade)
  shotType     String
  storageKey   String?
  incomingKey  String?
  width        Int?
  height       Int?
  pHash        String?
  createdAt    DateTime   @default(now())
}

// ───────────────────────────── Orders, payments, delivery ─────────────────────────────

model Order {
  id                  String         @id @default(cuid())
  buyerId             String
  buyer               User           @relation("BuyerOrders", fields: [buyerId], references: [id])
  sellerId            String
  seller              User           @relation("SellerOrders", fields: [sellerId], references: [id])
  listingId           String
  listing             Listing        @relation(fields: [listingId], references: [id])
  fulfilmentMode      FulfilmentMode
  // One platform fee per order (§7.1). CHECKs: total = item + shipping + check;
  // vendorShare = item − platformFee; merchantShare = shipping + check + platformFee.
  itemPricePaise      Int
  shippingFeePaise    Int            @default(0)
  checkFeePaise       Int            @default(0)
  platformFeePaise    Int            @default(0)
  platformFeeBps      Int            @default(0) // snapshot of the % at order time (basis points)
  vendorSharePaise    Int            // itemPrice − platformFee
  merchantSharePaise  Int            // shipping + check + platformFee
  totalPaise          Int            // charged to buyer
  state               OrderState     @default(CREATED)
  inspectionReason    InspectionReason?
  buyerVehicleId      String?        // garage vehicle used for fit at checkout
  fitPath             Json?          // {interchangeLinkIds[], fitmentIds[]} that connected buyer vehicle → part (fitment learning)
  deliveryAddress     Json?          // snapshot
  pickupAddress       Json           // snapshot
  paymentExpiresAt    DateTime?
  sellerConfirmBy     DateTime?
  acceptanceEndsAt    DateTime?
  autoReleaseAt       DateTime?      // paidAt + settings.providerMaxHoldDays (45 per brief; verify at M8)
  deadlineBreachedAt  DateTime?      // set if autoReleaseAt passes while not terminal (§5.3)
  cancelReason        String?
  settingsVersion     Int
  idempotencyKey      String         @unique
  version             Int            @default(0)
  completedAt         DateTime?
  createdAt           DateTime       @default(now())
  updatedAt           DateTime       @updatedAt

  payment      Payment?
  shipments    Shipment[]
  inspections  Inspection[]
  dispute      Dispute?
  events       OrderEvent[]
  reviews      Review[]
  reconciliationMismatches ReconciliationMismatch[]
  @@index([buyerId, state])
  @@index([sellerId, state])
  @@index([state, autoReleaseAt])
}

model OrderEvent {
  id        String      @id @default(cuid())
  orderId   String
  order     Order       @relation(fields: [orderId], references: [id], onDelete: Cascade)
  fromState OrderState?
  toState   OrderState
  event     String
  actorType ActorType
  actorId   String?
  payload   Json?
  createdAt DateTime    @default(now())
  @@index([orderId, createdAt])
}

model Payment {
  id                      String                 @id @default(cuid())
  orderId                 String                 @unique
  order                   Order                  @relation(fields: [orderId], references: [id])
  provider                String
  providerOrderId         String                 @unique
  providerPaymentId       String?
  providerSessionId       String?
  status                  PaymentStatus          @default(CREATED)
  amountPaise             Int
  vendorId                String?                // provider vendor id at order time
  vendorSharePaise        Int
  merchantSharePaise      Int
  vendorSettlementStatus  VendorSettlementStatus @default(NOT_APPLICABLE)
  settlementEligibleAt    DateTime?
  paidAt                  DateTime?
  createdAt               DateTime               @default(now())
  updatedAt               DateTime               @updatedAt
  events                  PaymentEvent[]
  refunds                 Refund[]
}

model PaymentEvent {
  id              String   @id @default(cuid())
  paymentId       String
  payment         Payment  @relation(fields: [paymentId], references: [id], onDelete: Cascade)
  type            String   // ORDER_CREATED, PAYMENT_SUCCESS, PAYMENT_FAILED, SETTLEMENT_ELIGIBLE, VENDOR_SETTLED, REFUND_*
  providerEventId String?
  payload         Json
  createdAt       DateTime @default(now())
  @@index([paymentId, createdAt])
}

model Refund {
  id                String       @id @default(cuid())
  paymentId         String
  payment           Payment      @relation(fields: [paymentId], references: [id])
  amountPaise       Int          // = vendorPortionPaise + merchantPortionPaise
  vendorPortionPaise   Int       // taken back from the vendor share (§7.5)
  merchantPortionPaise Int       // returned from merchant share (fee, shipping, check)
  components        Json         // {item, shipping, check} refunded, for the admin view
  reason            String
  withSplitReversal Boolean      // true when vendor share not yet settled
  afterSettlement   Boolean      @default(false)
  providerRefundId  String?      @unique
  status            RefundStatus @default(REQUESTED)
  idempotencyKey    String       @unique
  createdAt         DateTime     @default(now())
  updatedAt         DateTime     @updatedAt
}

// [assumption A-8] Refund after the vendor share was already settled: the merchant funds the
// vendor portion and admins recover it from the seller manually. No automatic seller charge.
model SellerRecovery {
  id          String    @id @default(cuid())
  orderId     String
  sellerId    String
  refundId    String    @unique
  amountPaise Int
  status      String    // OPEN | RECOVERED | WRITTEN_OFF
  note        String?
  resolvedById String?
  resolvedAt  DateTime?
  createdAt   DateTime  @default(now())
  @@index([status])
}

model WebhookEvent {
  id              String    @id @default(cuid())
  provider        String    // cashfree | mock-payment | mock-shipping | <courier>
  providerEventId String
  type            String
  signatureValid  Boolean
  payload         Json
  receivedAt      DateTime  @default(now())
  processedAt     DateTime?
  error           String?
  @@unique([provider, providerEventId])
}

model IdempotencyKey {
  key        String   @id
  scope      String
  resultJson Json?
  createdAt  DateTime @default(now())
}

model Shipment {
  id              String            @id @default(cuid())
  orderId         String
  order           Order             @relation(fields: [orderId], references: [id])
  direction       ShipmentDirection
  provider        String
  providerRef     String?           @unique
  awb             String?
  status          ShipmentStatus    @default(QUOTED)
  fromAddress     Json
  toAddress       Json
  weightGrams     Int
  lengthCm        Int
  widthCm         Int
  heightCm        Int
  quotedFeePaise  Int
  pickupSlotStart DateTime?
  pickupSlotEnd   DateTime?
  etaDate         DateTime?
  createdAt       DateTime          @default(now())
  updatedAt       DateTime          @updatedAt
  trackingEvents  TrackingEvent[]
  dispute         Dispute?          @relation("ReturnShipment")
}

model TrackingEvent {
  id              String         @id @default(cuid())
  shipmentId      String
  shipment        Shipment       @relation(fields: [shipmentId], references: [id], onDelete: Cascade)
  providerEventId String
  status          ShipmentStatus
  description     String
  location        String?
  occurredAt      DateTime
  @@unique([shipmentId, providerEventId])
}

model Dispute {
  id                 String        @id @default(cuid())
  orderId            String        @unique
  order              Order         @relation(fields: [orderId], references: [id])
  reason             DisputeReason
  description        String
  status             DisputeStatus @default(OPEN)
  sellerResponse     String?
  sellerRespondedAt  DateTime?
  resolutionNote     String?
  refundAmountPaise  Int?
  resolvedById       String?
  resolvedAt         DateTime?
  returnShipmentId   String?       @unique
  returnShipment     Shipment?     @relation("ReturnShipment", fields: [returnShipmentId], references: [id])
  createdAt          DateTime      @default(now())
  evidence           DisputeEvidence[]
}

model DisputeEvidence {
  id          String       @id @default(cuid())
  disputeId   String
  dispute     Dispute      @relation(fields: [disputeId], references: [id], onDelete: Cascade)
  party       DisputeParty
  uploadedById String
  storageKey  String?
  incomingKey String?
  note        String?
  createdAt   DateTime     @default(now())
}

// ───────────────────────────── Trust, messaging, admin ─────────────────────────────

model Review {
  id        String          @id @default(cuid())
  orderId   String
  order     Order           @relation(fields: [orderId], references: [id])
  authorId  String
  author    User            @relation("ReviewAuthor", fields: [authorId], references: [id])
  subjectId String
  subject   User            @relation("ReviewSubject", fields: [subjectId], references: [id])
  direction ReviewDirection
  rating    Int             // 1–5, CHECK constraint
  text      String?
  createdAt DateTime        @default(now())
  @@unique([orderId, direction])
  @@index([subjectId])
}

model Report {
  id           String       @id @default(cuid())
  reporterId   String
  reporter     User         @relation("Reporter", fields: [reporterId], references: [id])
  targetType   ReportTarget
  listingId    String?
  listing      Listing?     @relation(fields: [listingId], references: [id])
  userId       String?
  user         User?        @relation("ReportedUser", fields: [userId], references: [id])
  messageId    String?
  message      Message?     @relation(fields: [messageId], references: [id])
  reason       String
  details      String?
  status       ReportStatus @default(OPEN)
  handledById  String?
  handledAt    DateTime?
  createdAt    DateTime     @default(now())
  @@index([status, createdAt])
}

model Conversation {
  id            String    @id @default(cuid())
  listingId     String
  listing       Listing   @relation(fields: [listingId], references: [id])
  buyerId       String
  buyer         User      @relation("ConvBuyer", fields: [buyerId], references: [id])
  sellerId      String
  seller        User      @relation("ConvSeller", fields: [sellerId], references: [id])
  lastMessageAt DateTime  @default(now())
  buyerReadAt   DateTime?
  sellerReadAt  DateTime?
  createdAt     DateTime  @default(now())
  messages      Message[]
  @@unique([listingId, buyerId])
  @@index([buyerId, lastMessageAt])
  @@index([sellerId, lastMessageAt])
}

model Message {
  id             String       @id @default(cuid())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  senderId       String
  sender         User         @relation(fields: [senderId], references: [id])
  body           String       // stored already masked
  wasMasked      Boolean      @default(false)
  createdAt      DateTime     @default(now())
  reports        Report[]
  @@index([conversationId, createdAt])
}

model SavedListing {
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  listingId String
  listing   Listing  @relation(fields: [listingId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
  @@id([userId, listingId])
}

model SavedSearch {
  id             String    @id @default(cuid())
  userId         String
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  label          String
  query          Json      // validated SearchQuery
  alertsEnabled  Boolean   @default(true)
  lastCheckedAt  DateTime?
  createdAt      DateTime  @default(now())
}

model Notification {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  type      String
  title     String
  body      String
  link      String?
  readAt    DateTime?
  createdAt DateTime  @default(now())
  deliveries NotificationDelivery[]
  @@index([userId, readAt])
}

model NotificationDelivery {
  id             String              @id @default(cuid())
  notificationId String
  notification   Notification        @relation(fields: [notificationId], references: [id], onDelete: Cascade)
  channel        NotificationChannel
  providerRef    String?
  status         String
  createdAt      DateTime            @default(now())
}

model SettingsVersion {
  id          String   @id @default(cuid())
  version     Int      @unique
  data        Json     // validated by SettingsSchema (Zod) – see §6.5
  isActive    Boolean  @default(false) // partial unique index: exactly one active
  note        String?
  createdById String?
  createdAt   DateTime @default(now())
}

model AuditLog {
  id         String    @id @default(cuid())
  actorType  ActorType
  actorId    String?
  action     String    // e.g. order.transition, settings.activate, category.update
  entityType String
  entityId   String
  before     Json?
  after      Json?
  requestId  String?
  createdAt  DateTime  @default(now())
  @@index([entityType, entityId])
  @@index([createdAt])
}

model OutboxJob {
  id           String       @id @default(cuid())
  queue        String
  name         String
  payload      Json
  runAt        DateTime     @default(now())
  status       OutboxStatus @default(PENDING)
  attempts     Int          @default(0)
  dispatchedAt DateTime?
  createdAt    DateTime     @default(now())
  @@index([status, runAt])
}

model ReconciliationRun {
  id         String   @id @default(cuid())
  runDate    DateTime
  status     String
  summary    Json?
  createdAt  DateTime @default(now())
  mismatches ReconciliationMismatch[]
}

model ReconciliationMismatch {
  id         String            @id @default(cuid())
  runId      String
  run        ReconciliationRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  orderId    String?
  order      Order?            @relation(fields: [orderId], references: [id])
  kind       String            // AMOUNT_MISMATCH, MISSING_LOCALLY, MISSING_AT_PROVIDER, STATUS_MISMATCH
  expected   Json?
  actual     Json?
  resolvedAt DateTime?
  resolvedById String?
}

model CatalogueImport {
  id           String       @id @default(cuid())
  kind         ImportKind
  fileName     String
  storageKey   String
  uploadedById String
  status       ImportStatus @default(VALIDATING)
  rowCount     Int          @default(0)
  errorCount   Int          @default(0)
  report       Json?        // [{row, field, message}]
  appliedAt    DateTime?
  createdAt    DateTime     @default(now())
}
```

**Hand-written SQL in migrations**

- For every table in `public` (including `_prisma_migrations`): `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` and `REVOKE ALL ON ... FROM anon, authenticated;`, plus `ALTER DEFAULT PRIVILEGES` so future tables aren't granted to those roles. A Vitest test fails if `pg_tables WHERE schemaname='public' AND NOT rowsecurity` returns anything, or if any row exists in `pg_policies` for `public`. A new table without RLS therefore breaks the build. The local test Postgres creates `anon` and `authenticated` roles in its init script so the same migration SQL runs there unchanged. An optional smoke test calls the Supabase REST endpoint with the anon key and expects no data. It runs only if `SUPABASE_ANON_KEY` is set, and it is not needed for M1.
- Partial unique indexes: one `GarageVehicle.isPrimary = true` per user; one `SettingsVersion.isActive = true`; one open `Order` per listing (`state NOT IN ('CANCELLED','COMPLETED','RESOLVED_REFUND','RESOLVED_RELEASE')`).
- CHECK constraints: `Fitment` has exactly one of partNumberId/listingId; `InterchangeLink.notes IS NOT NULL` when type is FITS_WITH_MODIFICATION; `partNumberAId <> partNumberBId`; `Review.rating BETWEEN 1 AND 5`; all `*Paise` columns `>= 0`; on `Order`: `platformFeePaise <= itemPricePaise`, `vendorSharePaise = itemPricePaise − platformFeePaise`, `merchantSharePaise = shippingFeePaise + checkFeePaise + platformFeePaise`, and `vendorSharePaise + merchantSharePaise = totalPaise`. Under the planned fee model this makes `totalPaise = item + shipping + check`, so the fee is counted once (§7.1). If Q1 is answered "buyer pays", only the `vendorSharePaise` and `totalPaise` constraints change. On `Refund`: `amountPaise = vendorPortionPaise + merchantPortionPaise`.
- `pg_trgm` extension and a trigram index on `Listing.title` for text search.

---

## 3. Folder structure

```
repart/
├─ app/                                # Next.js App Router (routes only; thin)
│  ├─ (public)/                        # home, search, listing, part-number, seller, static pages
│  ├─ (auth)/sign-in/...
│  ├─ (member)/                        # garage, sell, seller, orders, checkout, messages, account
│  ├─ mechanic/...
│  ├─ admin/...
│  ├─ api/                             # route handlers: health, webhooks, polling, uploads, csv export
│  ├─ offline/page.tsx
│  ├─ manifest.ts
│  ├─ layout.tsx  globals.css
├─ src/
│  ├─ components/
│  │  ├─ ui/                           # Button, Input, Select, SegmentedControl, OptionTile, Sheet, Dialog,
│  │  │                                # Toast, Tooltip, Skeleton, ProgressBar, Badge, Tabs, Price, PartNumberText,
│  │  │                                # DateText, Icon, EmptyState, ErrorState, PermissionDenied
│  │  ├─ layout/                       # TopBar, BottomBar, PageShell, Grid
│  │  ├─ listing/                      # ListingTile, FitStatusBar, FitLine, TrustLabel, Gallery, ConditionGrade
│  │  ├─ wizard/  order/  messages/  garage/  admin/  mechanic/
│  ├─ lib/                             # isomorphic helpers: money, dates, pincode, part-number normalise,
│  │  │                                # contact-detail masking, schemas (Zod)
│  │  └─ schemas/
│  ├─ server/
│  │  ├─ db.ts                         # Prisma client (server-only)
│  │  ├─ auth/                         # session, requireUser, requireRole
│  │  ├─ http/                         # defineAction, defineRoute, rate limit, request id, errors
│  │  ├─ services/
│  │  │  ├─ listing/                   # wizard, listingState, trustLabel, conditionGrade
│  │  │  ├─ risk/                      # pipeline, rules/*, vision stage, scoring, routing
│  │  │  ├─ inspection/                # requirement, scheduling, assignment, audit selection
│  │  │  ├─ interchange/               # groups, compatibility, fitStatus
│  │  │  ├─ search/
│  │  │  ├─ order/                     # orderState (the single transition service), pricing, timers
│  │  │  ├─ payment/                   # checkout, settlement, refunds, reconciliation, webhooks
│  │  │  ├─ shipping/  dispute/  review/  messaging/  notification/
│  │  │  ├─ catalogue/                 # CRUD + CSV import/validation
│  │  │  ├─ settings/  audit/  export/  agreement/
│  │  ├─ adapters/
│  │  │  ├─ otp/ payment/ shipping/ vision/ storage/ notification/
│  │  │  │   └─ types.ts  mock.ts  <real>.ts
│  │  │  └─ index.ts
│  │  ├─ images/                       # sharp pipeline: exif strip, blur, brightness, pHash
│  │  └─ jobs/                         # queue definitions + job payload schemas
│  └─ worker/
│     └─ index.ts                      # BullMQ workers + repeatable jobs
├─ prisma/
│  ├─ schema.prisma
│  ├─ migrations/
│  └─ seed/                            # seed.ts + SAMPLE data files (clearly named sample-*)
├─ prisma.config.ts
├─ tests/
│  ├─ unit/                            # Vitest
│  ├─ integration/                     # Vitest against local test Postgres (§10)
│  └─ e2e/                             # Playwright specs, axe, design-rule checks, screenshots
├─ scripts/
│  ├─ check-design-rules.ts            # no-radius / no-gradient / tells linter
│  └─ screenshots.ts
├─ public/                             # icons for PWA, category example shots (SAMPLE placeholders)
├─ docker-compose.yml                  # redis, minio, postgres-test (tests only, §10)
├─ .env.example   .gitignore   README.md   PLAN.md
├─ eslint.config.mjs  tailwind (CSS-first config in globals.css)  tsconfig.json
├─ vitest.config.ts  playwright.config.ts
```

---

## 4. Route and page map

Legend: **Auth** = who may open it. P = public, M = signed-in member, Mech = mechanic, A = admin. Every page implements loading (layout-matched skeleton), empty, error, offline and permission-denied states.

### 4.1 Public
| Route | Screen (§9) | Auth |
|---|---|---|
| `/` | Home: vehicle selector ("What do you ride?") + part-number search; parts for primary bike (if garage); 3-sentence how-it-works; recently listed; Sell prompt | P |
| `/search?vehicle=&pn=&q=&category=&condition=&min=&max=&distance=&trust=&mode=&sort=` | Search results, filters, sort, empty state with save-search | P (save search needs M) |
| `/listings/[id]` | Listing detail: gallery, fit status bar, facts, part number + equivalents, trust label, seller summary, delivery estimate, Partner Check line, Buy now / Message / Save / Report | P (actions need M) |
| `/parts/[brand]/[number]` | Part-number page: equivalents (with type, source, notes), compatible vehicles, live listings, "Suggest an equivalent part number" | P |
| `/sellers/[id]` | Seller public profile | P |
| `/how-it-works`, `/help`, `/terms`, `/privacy` | Static; Terms/Privacy marked TODO | P |
| `/offline` | PWA offline fallback | P |

### 4.2 Sign-in
| Route | Screen | Auth |
|---|---|---|
| `/sign-in?next=` | Phone number | P |
| `/sign-in/verify` | OTP entry | P (pending challenge) |
| `/sign-in/about-you` | Name + consent summary + link to full policy | new user |
| `/sign-in/add-bike` | Add your bike (skippable), then redirect to `next` | M |

### 4.3 Member: garage, account, saved
| Route | Screen | Auth |
|---|---|---|
| `/garage` | Bikes list, set primary, parts that fit each bike | M |
| `/garage/add`, `/garage/[vehicleId]` | Add / edit bike | M |
| `/garage/searches` | Saved searches with alert toggles | M |
| `/account` | Profile, links | M |
| `/account/addresses` | Addresses | M |
| `/account/saved` | Saved listings | M |
| `/account/privacy` | Consents (view/withdraw), data request | M |
| `/account/notifications` | In-app notifications | M |

### 4.4 Selling
| Route | Screen | Auth |
|---|---|---|
| `/sell` | Start a listing / continue drafts | M |
| `/sell/[id]/bike` | Step 1 of 7: Bike | owner |
| `/sell/[id]/part` | Step 2: category, part name, part number + hint, suggested vehicles to confirm | owner |
| `/sell/[id]/condition` | Step 3: checklist, resulting grade | owner |
| `/sell/[id]/photos` | Step 4: shot list, examples, on-device quality warnings, upload | owner |
| `/sell/[id]/details` | Step 5: km, reason, description with inline contact warning | owner |
| `/sell/[id]/price` | Step 6: price (+ comparable range when enough data), pickup address, weight band, packaging guide | owner |
| `/sell/[id]/review` | Step 7: buyer-view preview, Submit listing | owner |
| `/sell/[id]/status` | "Checking your listing" live result; changes requested with Fix links | owner |
| `/seller` | Seller dashboard: listings grouped by status | M |
| `/seller/orders`, `/seller/orders/[id]` | Orders to handle: confirm availability (countdown), inspection appointment, pickup slot + packaging guide, shipment status, dispute response | seller of order |
| `/seller/payouts` | Payout status and history | M |
| `/seller/payouts/setup` | Payout account onboarding via provider | M |

### 4.5 Buying
| Route | Screen | Auth |
|---|---|---|
| `/checkout/[listingId]` | Address → serviceability + quote → Partner Check line → breakdown → Pay | M (not seller) |
| `/checkout/return?order=` | Payment return page (polls until webhook confirms) | buyer |
| `/orders` | My orders | M |
| `/orders/[id]` | Order page: vertical timeline, tracking, confirm/report with countdown, review prompt | buyer |
| `/orders/[id]/report` | Report a problem: reason, photos, description | buyer |
| `/orders/[id]/dispute` | Dispute status and next steps | buyer, seller |
| `/orders/[id]/review` | Leave a review | buyer, seller |

### 4.6 Messages
| Route | Screen | Auth |
|---|---|---|
| `/messages` | Inbox, one thread per listing | M |
| `/messages/[conversationId]` | Thread with pinned listing summary, masking note, report message | participants |

### 4.7 Mechanic portal
| Route | Screen | Auth |
|---|---|---|
| `/mechanic` | Jobs: today and upcoming | Mech |
| `/mechanic/jobs/[id]` | Job detail: address, slot, part summary, seller photos | Mech (assigned partner) |
| `/mechanic/jobs/[id]/inspect` | Inspection form → Submit inspection | Mech |
| `/mechanic/history` | History and earnings | Mech |

### 4.8 Admin
| Route | Screen | Auth |
|---|---|---|
| `/admin` | Overview metrics + disputes within 7 days of auto-release deadline + reconciliation mismatches | A |
| `/admin/listings`, `/admin/listings/[id]` | Listing review queue (flagged, high risk) + risk assessment detail | A |
| `/admin/catalogue` (+ `/makes`, `/models`, `/variants`, `/part-numbers`) | Catalogue CRUD | A |
| `/admin/catalogue/import`, `/admin/catalogue/import/[id]` | CSV import, validation report, apply | A |
| `/admin/interchange` | Interchange review queue (pending, flagged) | A |
| `/admin/categories`, `/admin/categories/[id]` | Tiers, thresholds, fees, checklists, photo guides | A |
| `/admin/settings`, `/admin/settings/versions/[v]` | Risk rules and settings, versions, diff, activate | A |
| `/admin/mechanics`, `/admin/mechanics/[id]` | Onboarding, service areas, capacity, assignment | A |
| `/admin/orders`, `/admin/orders/[id]` | Orders, event history, payment events | A |
| `/admin/disputes`, `/admin/disputes/[id]` | Evidence view, resolution actions | A |
| `/admin/reports` | Reports | A |
| `/admin/users`, `/admin/users/[id]` | Users, roles, suspend | A |
| `/admin/agreement` | Agreement dashboard | A |
| `/admin/export` | Training-data CSV export | A |
| `/admin/audit` | Audit log | A |
| `/admin/reconciliation` | Reconciliation runs and mismatches | A |

### 4.9 API route handlers
| Route | Purpose | Auth |
|---|---|---|
| `GET /api/health` | DB, Redis, storage checks | P (no details leaked) |
| `POST /api/webhooks/payments/cashfree` | Cashfree webhooks (signature verified, idempotent) | signature |
| `POST /api/webhooks/payments/mock` | Mock provider webhooks | signature (mock secret) |
| `POST /api/webhooks/shipping/[provider]` | Courier tracking (courier partner identity) | signature |
| `POST /api/uploads/sign` | Signed upload URL for a photo slot | M / Mech |
| `GET /api/listings/[id]/check-status` | Polling for "Checking your listing" | owner |
| `GET /api/messages/[conversationId]?after=` | Message polling | participants |
| `GET /api/admin/export/training.csv` | Streamed CSV | A |
| `GET /api/vehicles/*`, `/api/part-numbers/lookup` | Selector data | P |

All mutations not listed are server actions built with `defineAction`.

---

## 5. State machines

Both are implemented as a declarative transition table (`{from, event, to, allowedActors, guard, effects}`) consumed by a single `transition()` function. Anything not in the table throws `IllegalTransitionError`. Unit tests cover every row plus a property test that no event is accepted from a terminal state.

### 5.1 Listing

```
DRAFT ──submit──► SUBMITTED ──worker picks up──► SCREENING ──┬─ hard failures ─► CHANGES_REQUESTED ──seller resubmits──► SUBMITTED
  ▲                                                          ├─ reject rule / admin ─► REJECTED (terminal)
  │                                                          └─ pass ─► LIVE ──order created──► RESERVED ──┬─ order completed/released ─► SOLD
  │                                                                      │  ▲                             ├─ order cancelled ─► LIVE
  │                                                                      │  └─────────────────────────────┘
  │                                                                      │                                └─ inspection FAIL ─► CHANGES_REQUESTED
  └──────── material edit of a LIVE listing re-enters SUBMITTED ─────────┘
DRAFT | CHANGES_REQUESTED | LIVE ──seller withdraws──► WITHDRAWN
```

| # | From | Event | To | Triggered by | Guards / effects |
|---|---|---|---|---|---|
| L1 | DRAFT | `submit` | SUBMITTED | Seller (Step 7) | All 7 steps valid; if `fulfilmentMode=DELIVERY`, payout account must be ACTIVE (§3). Local-pickup listings may be submitted without it, as the brief allows, but "Buy now" stays disabled until the seller's payout account is ACTIVE, because the seller share can't be split to a non-existent vendor **[assumption A-6]**. Rate limited. Enqueue risk job. |
| L2 | CHANGES_REQUESTED | `resubmit` | SUBMITTED | Seller | Same guards. |
| L3 | SUBMITTED | `screeningStarted` | SCREENING | Worker | — |
| L4 | SCREENING | `screeningFailed` | CHANGES_REQUESTED | Worker (risk pipeline) | Store RiskAssessment with fixable reasons; notify seller. |
| L5 | SCREENING | `screeningPassed` | LIVE | Worker | Store inspection requirement + trust label; notify seller ("Part listed"); trigger saved-search alerts. |
| L6 | SCREENING | `screeningRejected` | REJECTED | Worker (rule marked `reject`, e.g. prohibited item) **[assumption]** | Notify seller with reason. |
| L7 | LIVE, CHANGES_REQUESTED | `adminReject` | REJECTED | Admin (review queue) | Reason required; audited. |
| L8 | LIVE | `adminRequestChanges` | CHANGES_REQUESTED | Admin | Reason required. |
| L9 | LIVE | `materialEdit` | SUBMITTED | Seller edits photos, category, part number, checklist or price by more than the configured % **[assumption]** | Re-run checks. Minor edits (description typo) stay LIVE but are re-masked. |
| L10 | LIVE | `reserve` | RESERVED | Order service at order CREATED | Only one open order per listing (DB index). |
| L11 | RESERVED | `release` | LIVE | Order service on CANCELLED (payment expired/failed, seller timeout, buyer cancel) | — |
| L12 | RESERVED | `inspectionFailed` | CHANGES_REQUESTED | Order service on inspection FAIL | Copy mechanic notes into `sellerMessage`. |
| L13 | RESERVED | `sold` | SOLD | Order service on COMPLETED or RESOLVED_RELEASE | `soldAt`. |
| L14 | RESERVED | `returnedAfterDispute` | WITHDRAWN **[assumption]** | Order service on RESOLVED_REFUND | Seller may relist as a new draft copied from this one. |
| L15 | DRAFT, CHANGES_REQUESTED, LIVE | `withdraw` | WITHDRAWN | Seller or admin | Not allowed while RESERVED. |

### 5.2 Order

Happy path (delivery): `CREATED → PAID_HELD → AWAITING_SELLER → [INSPECTION_SCHEDULED → INSPECTION_PASSED] → PICKUP_SCHEDULED → IN_TRANSIT → DELIVERED → ACCEPTANCE_WINDOW → COMPLETED`

Local pickup (NOT_SHIPPABLE): `... AWAITING_SELLER → [INSPECTION_SCHEDULED → INSPECTION_PASSED] → AWAITING_HANDOVER → ACCEPTANCE_WINDOW → COMPLETED`

| # | From | Event | To | Triggered by | Effects |
|---|---|---|---|---|---|
| O1 | — | `create` | CREATED | Buyer (Pay) | Price snapshot; reserve listing (L10); create provider order; `paymentExpiresAt = now + paymentTtl` (default 15 min). |
| O2 | CREATED | `paymentSucceeded` | PAID_HELD | Payment webhook (signature verified, deduplicated) | Record payment; `autoReleaseAt = paidAt + settings.providerMaxHoldDays` (default 45 per §3; whether the provider counts from payment or from another event is verified at M8 **[assumption A-9]**); settlement status HELD. |
| O3 | CREATED | `paymentFailed` / `paymentExpired` | CANCELLED | Webhook / timer | Release listing (L11). No refund needed. |
| O4 | PAID_HELD | `notifySeller` | AWAITING_SELLER | System (immediately after O2) | `sellerConfirmBy = now + 24h`; decide audit selection (§6.3); notify seller. |
| O5 | AWAITING_SELLER | `sellerConfirmed` (inspection needed) | INSPECTION_SCHEDULED | Seller confirms + picks slot | Create Inspection; assign partner (§6.4); notify buyer, garage. |
| O6 | AWAITING_SELLER | `sellerConfirmed` (no inspection, delivery) | PICKUP_SCHEDULED | Seller confirms + picks pickup slot | Book pickup via ShippingProvider. |
| O7 | AWAITING_SELLER | `sellerConfirmed` (no inspection, local pickup) | AWAITING_HANDOVER | Seller | Share meeting details in thread. |
| O8 | AWAITING_SELLER | `sellerTimeout` | CANCELLED | Timer (`sellerConfirmBy`) | Full refund; listing → LIVE. |
| O9 | AWAITING_SELLER | `sellerDeclined` | CANCELLED | Seller | Full refund; listing → WITHDRAWN **[assumption]** (declining implies not available). |
| O10 | INSPECTION_SCHEDULED | `inspectionPassed` (PASS / PASS_WITH_NOTES) | INSPECTION_PASSED | Mechanic submits | Update trust label to Partner Check; notify buyer (notes visible). |
| O11 | INSPECTION_SCHEDULED | `inspectionFailed` | CANCELLED | Mechanic submits | Full refund incl. check fee; listing → CHANGES_REQUESTED with notes (L12). |
| O12 | INSPECTION_PASSED | `pickupBooked` | PICKUP_SCHEDULED | System (auto-books using slot seller chose) or seller | — |
| O13 | INSPECTION_PASSED | `handoverArranged` | AWAITING_HANDOVER | System (local pickup) | — |
| O14 | PICKUP_SCHEDULED | `pickedUp` | IN_TRANSIT | Courier webhook | — |
| O15 | IN_TRANSIT | `delivered` | DELIVERED | Courier webhook | — |
| O16 | DELIVERED | `openAcceptanceWindow` | ACCEPTANCE_WINDOW | System (immediately after O15) | `acceptanceEndsAt = now + 48h`. |
| O17 | AWAITING_HANDOVER | `buyerConfirmedHandover` | ACCEPTANCE_WINDOW | Buyer | `acceptanceEndsAt = now + 48h`. |
| O18 | ACCEPTANCE_WINDOW | `buyerAccepted` | COMPLETED | Buyer ("Confirm it's OK") | Mark settlement eligible; fitment learning (+confirmationCount); review prompts. |
| O19 | ACCEPTANCE_WINDOW | `acceptanceTimeout` | COMPLETED | Timer | Same as O18. |
| O20 | ACCEPTANCE_WINDOW | `problemReported` | DISPUTED | Buyer | Create Dispute; if DOES_NOT_FIT: +flaggedCount, add links/fitments to review queue; notify seller + admin. |
| O21 | DISPUTED | `resolveRefund` | RESOLVED_REFUND | Admin (explicit decision, reason required) | Book return shipment where applicable; refund allocated per §7.5 (pre- or post-settlement path); listing L14. |
| O22 | DISPUTED | `resolveRelease` | RESOLVED_RELEASE | Admin (explicit decision, reason required) | Mark settlement eligible; listing SOLD. |
| O23 | PAID_HELD … PICKUP_SCHEDULED, AWAITING_HANDOVER | `buyerCancelled` | CANCELLED | Buyer (before pickup) | Refund per the admin-configured cancellation rules (§7.5, default table is **[assumption A-5]**); listing → LIVE. |
| O24 | any non-terminal after payment | `adminCancelled` | CANCELLED | Admin | Refund amount chosen by admin; reason required. |
| O25 | IN_TRANSIT | `deliveryFailed` (lost / RTO) | CANCELLED **[assumption]** | Courier webhook → admin confirms | Full refund; listing → LIVE when returned to seller. |

Terminal: COMPLETED, RESOLVED_REFUND, RESOLVED_RELEASE, CANCELLED.

Every transition: notification to relevant parties (templated per event), `OrderEvent`, `AuditLog`.

### 5.3 Provider auto-release deadline (disputes)

The brief requires: store each order's auto-release deadline, show admins DISPUTED orders within 7 days of it, and never let a dispute pass it unresolved. Resolution is always an **explicit admin decision** (O21/O22). The system never auto-refunds or auto-releases a dispute **[decision D-6]**.

- **Stored:** `Order.autoReleaseAt` is set at O2 from `settings.providerMaxHoldDays`. The 45-day figure comes from §3 ("at the time of writing"); it is a setting, not a hard-coded provider rule, and is checked against Cashfree's docs at M8.
- **Surfaced (required by the brief):** the admin overview has a "Disputes near auto-release" panel listing every DISPUTED order with `autoReleaseAt − now ≤ settings.disputeDeadlineWarningDays` (7), sorted by time left, with a countdown and a direct link to the resolution screen. `/admin/disputes` sorts by the same deadline by default.
- **Cannot pass silently:** a job runs hourly. At 7, 3 and 1 days and at 12 hours before the deadline, it sends escalating notifications (in-app + email + SMS) to every admin, and each alert is written to `AuditLog`. The alert can't be dismissed; only resolving the dispute clears it. The admin UI shows a persistent banner on every admin page while any dispute is within 24 hours.
- **Prevention:** disputes can only be opened during the acceptance window, which normally ends well before 45 days. Late orders are the main risk (slow inspection or transit). **[assumption A-10]** The same panel also lists any paid, non-terminal order (e.g. still IN_TRANSIT) within 7 days of `autoReleaseAt`. If funds auto-release before the buyer accepts, the brief's "held until the buyer accepts" promise breaks, so admins need to see these too. This only surfaces orders; it changes no state.
- **Breach procedure (if it happens anyway):** when `autoReleaseAt` passes on a non-terminal order, the job sets `deadlineBreachedAt`, writes an AuditLog entry and raises a critical admin alert. The payment's settlement status is re-checked through the provider (and reconciliation). The dispute stays open for an explicit admin decision. Any later refund automatically uses the post-settlement path (§7.5). The system takes no automatic money action.

---

## 6. Risk check, inspection tiers, interchange

### 6.1 Risk check pipeline (§6)

Job `risk.check(listingId)` on queue `risk`, enqueued in the same transaction as L1/L2/L9. Seller lands on `/sell/[id]/status` immediately; the page polls `check-status`.

Each rule is a pure function `(ctx) => CheckResult { code, passed, severity: HARD|SOFT|INFO, scoreWeight, message, fixStep, photoId? }`, registered in `src/server/services/risk/rules/`. Thresholds come from the active `SettingsVersion`. Adding or tuning a rule means bumping the settings version.

**Stage 1: rules (always)**
| Code | Check | Severity |
|---|---|---|
| `REQUIRED_FIELDS` | Zod listing-complete schema | HARD |
| `PHOTO_GUIDE` | ≥3 photos and every required `shotType` present | HARD |
| `MIN_RESOLUTION` | shortest side ≥ `minPhotoShortSidePx` | HARD per photo |
| `BLUR` | variance of Laplacian ≥ `blurThreshold` | HARD per photo, message names the photo + retake tip |
| `BRIGHTNESS` | mean luma within `[minBrightness, maxBrightness]` | HARD per photo |
| `DUPLICATE_PHOTO` | Hamming distance of pHash ≤ `phashMaxDistance` vs photos of *other sellers'* listings | HARD (other seller), SOFT (seller's own older listing) |
| `PRICE_OUTLIER` | robust z-score (median/MAD) against comparable LIVE/SOLD listings in same category + grade (+ part-number group when present); skipped if fewer than `minComparables` | SOFT |
| `BLOCKING_CHECKLIST` | any checklist answer with `blocksListing` answered "bad" | HARD |
| `CONTACT_DETAILS` | regexes for Indian mobile numbers (incl. spaced/obfuscated forms), emails, UPI handles (`name@bank`), URLs; text is masked and flagged | SOFT (masked, not blocked) |

**Stage 2: vision** (only if no HARD failure)
| Code | Check | Severity |
|---|---|---|
| `CATEGORY_MISMATCH` | `classifyCategory` top label ≠ chosen category with confidence ≥ threshold | SOFT (score) |
| `DAMAGE_CONTRADICTION` | damage detected with confidence ≥ threshold while checklist says "no damage" | SOFT, high weight |
| `PART_NUMBER_OCR` | OCR text normalised; if a number is read and differs from entered number | SOFT; match adds positive signal |

**Stage 3: score and route**
- `score = min(100, Σ weight of failed SOFT checks × confidence)`. Weights live in settings.
- Any HARD failure → `CHANGES_REQUESTED`, each reason mapped to a fix step (`/sell/[id]/photos#photo-2`, etc.).
- `reject` rules (none by default) → `REJECTED`.
- Otherwise → `LIVE`; compute requirement (6.2) and trust label (6.2); if `score ≥ settings.adminReviewThreshold`, or any SOFT flag such as contact details or a duplicate photo from the seller's own listing fired, the listing still goes LIVE (with Tier B's risk-based Partner Check where it applies) and also enters the admin listing review queue **[decision D-5]**. Admins can then request changes (L8) or reject (L7); both are audited.
- Persist `RiskAssessment` with `ruleSetVersion` (settings version) and `visionModelVersion` from the adapter.
- Job is idempotent: it takes a row lock on the listing and exits if the status is no longer SUBMITTED/SCREENING.

**Photo quality on-device (Step 4):** the same blur/brightness maths runs in the browser on a downscaled canvas so warnings appear before upload. The server result is authoritative.

### 6.2 Inspection requirement and trust label

`computeInspectionRequirement(category, pricePaise, riskScore, settings)`:
```
Tier C                                     → REQUIRED (TIER_C)
Tier B and price ≥ category threshold      → REQUIRED (TIER_B_THRESHOLD)
Tier B and riskScore ≥ settings.riskThresholdB → REQUIRED (HIGH_RISK)
Tier B otherwise                           → OPTIONAL (buyer pays optionalCheckFee)
Tier A and category.optionalCheckEnabled   → OPTIONAL
Tier A otherwise                           → NOT_NEEDED
```
Stored on the listing and snapshotted onto the order. The check fee for REQUIRED inspections is the category's `optionalCheckFee`, shown to the buyer as the "Partner Check" line **[assumption A-4]**. AUDIT inspections are always ₹0 (§6).

Trust label (recomputed on screening, inspection and edit):
- `PARTNER_CHECK` if the latest inspection for this listing is PASS/PASS_WITH_NOTES and no material edit since. Displayed as "Inspected by [garage] on [date]. Visual and basic check."
- `SCREENED` if the latest risk assessment had no HARD failures and `score < settings.lowRiskThreshold`.
- `SELLER_DECLARED` otherwise.
A unit test scans all UI strings for "certified", "guaranteed", "verified quality" and fails if found.

### 6.3 Audit selection
At O4, if the order has no inspection: `selected = hash(orderId + settingsVersion) mod 10000 < auditPercent × 100`. Deterministic, so it can be reproduced in tests and audits. If selected, reason AUDIT, fee 0, and the buyer sees "This order was picked for a routine quality check". The order then goes through INSPECTION_SCHEDULED.

### 6.4 Mechanic assignment
Candidate partners are active and have `servicePincodes` containing the seller's pickup pincode. Pick the one with remaining capacity on the chosen day, ordered by lowest load and then best quality stats. If none is available, the seller sees only slots with capacity. If there is no partner at all for a REQUIRED inspection, the listing is shown as "Partner Check not available in your area" and "Buy now" is disabled with that explanation while admins are alerted **[assumption A-12]**. Admin can reassign.

### 6.5 Settings (versioned)
A single `SettingsSchema` (Zod) covers platform fee bps, seller confirm hours, acceptance hours, payment TTL, audit %, risk thresholds, rule weights, photo thresholds, `minComparables`, price-outlier z, max hold days (45), dispute warning days (7), buyer cancellation rules, rate limits and signed-URL TTL. Editing creates a new inactive version; activating it is audited with a before/after diff. The version number is the `ruleSetVersion`. Category edits are audited in `AuditLog` with before/after.

### 6.6 Part-number interchange (§8)

- **Normalisation:** `normalize(s) = s.toUpperCase().replace(/[\s\-]/g, '')`, used for lookup, storage (`normalized`) and matching. `display` keeps the original.
- **Groups:** an undirected graph whose nodes are PartNumbers and whose edges are `status=APPROVED AND type IN (EXACT_EQUIVALENT, SUPERSEDED_BY)`. For a safety-critical category, only edges with `source IN (OEM_CATALOGUE, MECHANIC_CONFIRMED)` count. A group is the connected component, found with a Postgres recursive CTE (bounded depth 10, cycle-safe). Results are cached in Redis keyed by part number, and the cache is invalidated when any link touching the component changes.
- **FITS_WITH_MODIFICATION:** only one-hop neighbours of the searched number itself, never expanded. Their notes are always shown.
- **Match labels** on each result: `Same part number`, `Equivalent (source)`, `Replaced by newer number (source)`, `Fits with modification: <notes>`.
- **Search by part number:** normalise → find PartNumber(s) → group + one-hop mods → LIVE listings with `partNumberId` in the set, plus listings whose `partNumberEntered` normalises to a member.
- **Search by vehicle:** variant → `Fitment(variantId, verdict=FITS, partNumberId not null)` → expand each through groups → listings with those part numbers; union with listings whose own `Fitment(listingId, variantId)` exists. Ranking for "best fit": mechanic/part-number match > buyer-confirmed > seller-declared > modification.
- **Fit status (bar + tile line):** `fitStatus(listing, garageVehicle)` returns
  1. `NOT_FIT` if a DOES_NOT_FIT fitment exists for this listing/part group + variant;
  2. `FITS` (source text) if there is a PART_NUMBER_MATCH or MECHANIC_CONFIRMED fitment, or a group-member part-number fitment (safety-critical rule applied);
  3. `MODIFICATION` (note) if the link is FITS_WITH_MODIFICATION;
  4. `SELLER_SAYS` if only SELLER_DECLARED;
  5. `NO_VEHICLE` if the user has no garage.
  Copy follows §10 exactly, using the user's vehicle name from the catalogue.
- **Listing wizard Step 2:** entered number → group → compatible variants suggested with checkboxes; confirmed ones are saved as listing Fitments with source PART_NUMBER_MATCH, and the seller's own bike is saved as SELLER_DECLARED.
- **Community suggestions:** "Suggest an equivalent part number" creates a `USER_SUBMITTED` link with status PENDING that appears in `/admin/interchange`. Rate limited.
- **Fitment learning:** on COMPLETED without a DOES_NOT_FIT dispute, the path that connected the buyer's garage vehicle to the listing (stored on the order at checkout as `fitPath`: link ids + fitment ids) gets `confirmationCount++`. On DOES_NOT_FIT, the same path gets `flaggedCount++` and `inReviewQueue=true`. *(Adds `fitPath Json?` and `buyerVehicleId String?` to Order; this will be included in the M1 schema.)*

---

## 7. Payments end to end

### 7.1 Money model per order: one platform fee [decision D-3]

**What the brief says.** §3: "Our share (platform fee, delivery fee, check fee) stays with the merchant account; the item price minus the platform fee goes to the vendor." §7: completed orders release funds "to the seller minus the platform fee". §5: platform fee is an admin-configurable %, default 0. §9: the checkout breakdown shows "item, delivery, check, platform fee, total".

**Owner decision.** There is exactly one economic platform fee per transaction, and it is deducted from the seller's settlement.

**Conflict in the worked example (flagged, not silently resolved).** The example given with the decision was item ₹10,000, delivery ₹300, check ₹200, fee ₹300 → buyer total ₹10,800, seller receives ₹9,700. Under those numbers the platform keeps ₹10,800 − ₹9,700 = ₹1,100. Delivery and check account for ₹500 of that, which leaves **₹600 of fee**: the buyer paid ₹300 and the seller gave up ₹300. That is the double charge the decision rules out. Only one of the two can be true:

| Model | Buyer pays | Seller receives | Platform keeps (fee) | Matches |
|---|---|---|---|---|
| **S: seller bears the fee (planned)** | 10,000 + 300 + 200 = **₹10,500** | 10,000 − 300 = **₹9,700** | **₹300** (+ ₹300 delivery, ₹200 check passed on to courier/garage) | Brief §3/§7 vendor rule; the "one fee, deducted from seller" decision |
| B: buyer bears the fee | 10,000 + 300 + 200 + 300 = **₹10,800** | **₹10,000** | **₹300** (+ ₹500 as above) | The buyer total in the example; conflicts with §3 "item price minus platform fee goes to the vendor" |
| Example as written | ₹10,800 | ₹9,700 | **₹600** | Neither: two fees |

This plan implements **Model S** because it is the only model consistent with both the brief (primary source) and the one-fee decision. To satisfy §9, the buyer's breakdown still shows the platform fee line, worded as **"Platform fee: deducted from seller payout"** with the amount. It is visibly excluded from the buyer's total so the buyer can't read it as a second charge. **Confirmed by the owner (Q1 → Model S, decision D-10).**

**Formulas (Model S), all integer paise, computed only in `pricing.quote()`:**
```
platformFee   = round_half_up(itemPrice × platformFeeBps / 10000)   (0 ≤ platformFee ≤ itemPrice)
total         = itemPrice + shippingFee + checkFee                  charged to buyer
vendorShare   = itemPrice − platformFee                             split to seller's vendor account, deferred
merchantShare = shippingFee + checkFee + platformFee                stays with RePart's merchant account
invariant     : vendorShare + merchantShare = total
```
The quote, including `platformFeeBps`, is snapshotted on the Order. Later settings changes never affect an existing order.

**Ownership of each component**
| Component | Paid by | Held in | Ends with | Notes |
|---|---|---|---|---|
| Item price − platform fee | Buyer | Vendor split, deferred settlement | Seller, on COMPLETED / RESOLVED_RELEASE (or provider auto-release) | Only this amount is ever split to the vendor. |
| Platform fee | Seller (deducted from item price) | Merchant | RePart | The only platform fee. No other seller charge exists; any future one would need a separate, explicit definition. |
| Delivery fee | Buyer | Merchant | RePart, which pays the courier (off-platform) | Return shipment cost on RESOLVED_REFUND is RePart's cost **[assumption A-7]**, not a seller charge. |
| Check fee | Buyer (0 for AUDIT) | Merchant | RePart, which pays the garage (off-platform, `MechanicPartner.feePerInspection`) **[assumption A-4]** | Refunded in full on inspection FAIL (§7). |

**Views that show these numbers** all read the Order snapshot through a single `orderMoneyView()` so they can't disagree: the checkout breakdown, the buyer's order page (total, and for refunds the refunded components), the seller order page and payouts ("Item ₹10,000, platform fee −₹300, you receive ₹9,700"), and admin order/dispute/reconciliation views (all components plus vendor/merchant split and refund portions).

### 7.2 Flow (provider-agnostic)
1. **Seller onboarding:** `/seller/payouts/setup` → `payment.createVendor(user, bankInput)`. Bank fields pass straight through the server to the provider and are **never logged or stored**; the logger redacts them by schema. We store `providerVendorId` + `status`. Status is refreshed by webhook where available and by polling on the page.
2. **Publish guard:** L1 requires `PayoutAccount.status = ACTIVE` for DELIVERY listings (§3). Local-pickup listings can publish, but checkout is blocked until the seller is ACTIVE **[assumption A-6]**.
3. **Checkout:** `checkoutService.pay()` (idempotency key per buyer+listing+quote) → O1 → `payment.createOrder({ amount, splits: [{ vendorId, amount: vendorShare }], deferredSettlement })` → returns a checkout session → client opens the provider checkout.
4. **Payment result:** the webhook is the source of truth (the return page only polls). Verify signature → insert `WebhookEvent` (dedupe) → `PaymentEvent` → O2/O3.
5. **Hold:** the vendor share sits in deferred settlement; `autoReleaseAt` is stored.
6. **Release:** on COMPLETED / RESOLVED_RELEASE → outbox job `payment.markSettlementEligible(order)` (idempotent) → settlement status ELIGIBLE → SETTLED on the settlement webhook.
7. **Refunds:** `refundService.refund(order, components, reason, idempotencyKey)`. Allocation is in §7.5. Every refund writes `Refund`, `PaymentEvent` and `AuditLog`, and is confirmed by a verified refund webhook.
8. **Reconciliation:** a daily repeatable job pulls provider settlement/order data for the previous day, compares amount, status and split per order, and writes `ReconciliationMismatch` rows shown in `/admin/reconciliation`.

### 7.3 Mock PaymentProvider (built first, M8)
- DB-backed fake (`mock_*` rows kept in its own tables under a `mock` Postgres schema, or in Redis) with a fake hosted checkout page at `/dev/mock-pay/[session]` offering *Pay successfully / Fail / Abandon*. It is only mounted when `PAYMENT_PROVIDER=mock` and `NODE_ENV !== 'production'`.
- It emits webhooks to `/api/webhooks/payments/mock` signed with HMAC-SHA256 using `MOCK_WEBHOOK_SECRET`, with the same shape as our normalised event type, so the whole webhook path is tested.
- It simulates vendor onboarding (instant ACTIVE, or a toggle for ACTION_REQUIRED), settlement eligibility, settlement after N minutes, refunds (success/failure) and a settlements report for reconciliation.
- It supports fault injection for tests: duplicate webhooks, out-of-order webhooks, refund failure.

### 7.4 Cashfree Easy Split implementation (sandbox only, M8 second half)
I could not reach Cashfree's documentation while writing this plan (web access failed), so **no endpoint paths, API versions or field names are fixed here**. Before writing the adapter I will read the current official docs for: PG Create Order and payment sessions, Easy Split vendor management (create vendor, vendor status, bank verification), order splits at creation, split-after-payment, deferred/on-hold settlement and the API that makes a vendor settlement eligible immediately, refunds with split reversal, settlements/recon reports, the webhook signature scheme and webhook event types, and the sandbox base URL and test instruments.

Implementation rules:
- Base URL is chosen from `CASHFREE_ENV`. The adapter **refuses to start** unless `CASHFREE_ENV=sandbox`, and a unit test enforces this. Enabling production is a later deliberate change, not a config flip.
- Keys come only from `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` and `CASHFREE_ENV`. They are never logged and never exposed to the client. The hosted checkout gets only the session id.
- Webhook handler: read the raw body before JSON parsing, verify the signature with a constant-time compare, reject stale timestamps, then map provider events to our normalised `PaymentWebhookEvent` via Zod.
- Every outgoing monetary call sends a stable idempotency key/order reference so that retries cannot double-charge or double-refund.
- Contract tests run against recorded sandbox fixtures in CI. A manual `npm run test:cashfree-sandbox` script runs a live sandbox round trip only when sandbox keys are present.
- **Not configured until M8 [decision D-9].** Until then `PAYMENT_PROVIDER=mock`. `.env.example` lists `CASHFREE_APP_ID=`, `CASHFREE_SECRET_KEY=` and `CASHFREE_ENV=sandbox` as empty placeholders only. I will ask for sandbox credentials when M8 reaches the adapter, not before.
- Things to confirm in the docs at M8 before coding, each of which could change the design above: the hold-period length and when its clock starts; whether a held vendor settlement can be released early (the brief says yes) and whether it can be extended; how refunds interact with a split that is held versus already settled (split reversal support); whether the provider can recover amounts from a vendor's future settlements; and the webhook signature algorithm and headers. If the docs contradict the brief on any of these, I'll stop and raise it rather than work around it.

### 7.5 Refund allocation (one-fee model)
A refund is requested as components: `item` (0…itemPrice), `shipping` (0…shippingFee) and `check` (0…checkFee).
```
feeShare        = round_half_up(item × platformFee / itemPrice)   // platform fee returned in proportion to item refunded
vendorPortion   = item − feeShare                                 // taken back from the seller's share
merchantPortion = feeShare + shipping + check                     // returned by RePart
refund amount   = vendorPortion + merchantPortion
```
The platform keeps its fee only on the part of the sale that stands, so the fee is never charged on money returned to the buyer **[assumption A-7]**. Example: a full refund of the ₹10,500 order returns ₹9,700 from the vendor share and ₹800 (₹300 fee + ₹300 delivery + ₹200 check) from the merchant share.

| Case | Components refunded | Source |
|---|---|---|
| Payment failed/expired (O3) | Nothing captured, nothing to refund | — |
| Seller timeout / decline (O8, O9) | Everything | §7 "full refund" |
| Inspection FAIL (O11) | Everything, including check | §7 |
| Buyer cancels before pickup (O23) | Per the admin-configured table keyed by order state. Default: full before the inspection or pickup happens; after a completed inspection, everything except the check fee **[assumption A-5]** | §7 "per admin-configured rules" |
| Dispute → RESOLVED_REFUND (O21) | Admin chooses components; defaults to everything | §7 |
| Delivery failed (O25) | Everything **[assumption A-11]** | — |
| Admin cancel (O24) | Admin chooses components | — |

**Pre-settlement** (vendor settlement HELD/ELIGIBLE): refund with split reversal. The `vendorPortion` comes out of the held vendor share and the `merchantPortion` out of the merchant account.
**Post-settlement** (vendor already SETTLED, e.g. after provider auto-release): the buyer still receives the full refund amount. The merchant account funds all of it, and a `SellerRecovery` row records `vendorPortion` for manual admin recovery **[assumption A-8]**. Whether the provider supports automatic recovery is checked at M8.

**Guarantees (tested):** Σ refunds ≤ total; Σ vendorPortion ≤ vendorShare; Σ merchantPortion ≤ merchantShare; fee retained = platformFee − Σ feeShare ≥ 0; each refund has a unique idempotency key, so a retried request or duplicate webhook can't double-refund; refund status comes only from verified webhooks or provider status queries.

---

## 8. Design system implementation

### 8.1 Tailwind theme tokens
The current Tailwind major version uses CSS-first config (`@theme` in `globals.css`). I will confirm the current syntax at M1.

```css
@import "tailwindcss";

@theme {
  /* reset defaults we don't want available at all */
  --color-*: initial;
  --shadow-*: initial;
  --inset-shadow-*: initial;
  --drop-shadow-*: initial;
  --radius-*: initial;

  /* every radius token exists and is 0, so even a stray class renders square */
  --radius-xs: 0; --radius-sm: 0; --radius-md: 0; --radius-lg: 0; --radius-xl: 0;
  --radius-2xl: 0; --radius-3xl: 0; --radius-4xl: 0; --radius-full: 0; --radius: 0;

  /* colour */
  --color-ink: #1A2126;  --color-steel: #56626B;  --color-rule: #D3D8DB;
  --color-page: #F2F4F5; --color-surface: #FFFFFF;
  --color-action: #0B5CAD; --color-action-hover: #084A8C;
  --color-fit: #1B7A43;     --color-fit-tint: #E6F2EB;
  --color-caution: #7A5200; --color-caution-tint: #FCF1D9;
  --color-danger: #B42318;  --color-danger-tint: #FBE9E7;
  --color-transparent: transparent; --color-current: currentColor;

  /* the one allowed shadow */
  --shadow-float: 0 4px 16px rgb(26 33 38 / 0.12);

  /* type scale (rem) */
  --text-sm: 0.875rem;  --text-sm--line-height: 1.5;
  --text-base: 1rem;    --text-base--line-height: 1.5;
  --text-lg: 1.125rem;  --text-lg--line-height: 1.4;
  --text-xl: 1.375rem;  --text-xl--line-height: 1.25;
  --text-2xl: 1.75rem;  --text-2xl--line-height: 1.2;
  --text-3xl: 2.25rem;  --text-3xl--line-height: 1.15;

  --font-sans: var(--font-anek), system-ui, sans-serif;
  --spacing: 0.25rem;          /* 4px base */
  --container-page: 80rem;     /* 1280px */
  --breakpoint-lg: 64rem;
}

@layer base {
  body { @apply bg-page text-ink font-sans; font-stretch: 100%; }
  h1,h2,h3,h4 { font-stretch: 87.5%; font-weight: 600; }        /* narrower + semibold */
  :focus-visible { outline: 2px solid var(--color-action); outline-offset: 2px; border-radius: 0; }
  *, *::before, *::after { border-radius: 0 !important; }        /* belt and braces, incl. Radix/UA styles */
  input, select, textarea, button { appearance: none; }          /* kill native rounded controls */
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
}

@utility num      { font-variant-numeric: tabular-nums; }
@utility part-no  { font-variant-numeric: tabular-nums; font-size: 1.125em; font-weight: 600; letter-spacing: 0.04em; }
@utility prose-measure { max-width: 70ch; }
```

- Font: `next/font/google` `Anek_Latin` with the `wdth` axis, exposed as `--font-anek`. Anek Devanagari and Anek Kannada come later with the same setup.
- Icons: `lucide-react` through an `<Icon>` wrapper with a fixed `strokeWidth={1.75}` and size scale. Importing lucide directly elsewhere is blocked by lint.
- Components are built from scratch (Radix primitives used only for Dialog, Popover, Tooltip, Toast and Select behaviour). Selections use `OptionTile` (square tiles) and `SegmentedControl`, with no radio circles or checkbox ticks with radius. Yes/No checklist questions are a two-segment control.
- Formatting helpers: `formatPrice(paise)` (en-IN), `formatDate` (`28 Sep 2026`, `en-IN` with `day: 'numeric', month: 'short', year: 'numeric'`), `formatKm`.

### 8.2 Enforcing the hard rules automatically
Three layers, all running in CI and in the end-of-milestone check:

1. **Static check** (`scripts/check-design-rules.ts`, run by `npm run lint:design` and wrapped in a Vitest test so `npm test` fails too). It scans `app/`, `src/` and all CSS for:
   - any `rounded` / `rounded-*` class token (in `className`, `cn()`, `cva()` strings, template literals);
   - `border-radius` / `borderRadius` with a non-zero value in CSS, style objects or `@theme`;
   - `shadow-*` other than `shadow-float`; `drop-shadow`;
   - `bg-gradient-*`, `bg-linear-*`, `bg-radial-*`, `bg-conic-*`, `linear-gradient(`, `radial-gradient(`, `backdrop-blur`;
   - `uppercase` class / `text-transform: uppercase`; `tracking-*` outside the `part-no` utility;
   - `font-mono`, `monospace`;
   - `animate-*` other than the approved sheet/dialog/skeleton ones; `hover:-translate-y`, `hover:scale`;
   - emoji (Unicode `Extended_Pictographic`) in source strings;
   - ` · ` (middle dot) and trailing `→`/`->`/`›`/`»` in JSX text.
   Each violation is reported with file:line.
2. **ESLint** `no-restricted-syntax`/custom rule for the same class patterns inside JSX, so the editor catches them while typing.
3. **Rendered check in Playwright** (`tests/e2e/design-rules.spec.ts`), run on every screen that gets screenshotted. It walks every element and asserts: all four computed `border-*-radius` = `0px`; `box-shadow` is `none` unless the element has `data-layer="floating"`; `background-image` contains no gradient; `text-transform` ≠ uppercase; `font-family` has no monospace; no text node contains `·` between words or ends with an arrow; the focused element's outline is 2px action-coloured. It also runs axe (WCAG 2.1 AA) on the same pages.

### 8.3 Screenshot review per milestone
`npm run screenshots` logs in as sample users, visits each new route in each state (loaded, empty, error, permission-denied; offline via `context.setOffline`) at **375×812** and **1440×900**, and saves to `screenshots/<milestone>/<route>-<state>-<width>.png` (git-ignored). I review them against §10 (layout columns, sticky bars, fit bar prominence, tile content order, copy rules) and fix issues before the milestone summary.

---

## 9. Milestones

Each milestone ends with: `npm run typecheck && npm run lint && npm run lint:design && npm test && npm run test:e2e`, screenshots at 375/1440 of new screens, a review against §10, a summary of what was built and what is unfinished, and a **stop for your review**.

| # | Milestone | Scope | Key tests |
|---|---|---|---|
| **1** | Foundation | Read current Next.js, Tailwind, Prisma, Supabase docs. **Git, in this order [decision D-2]:** (1) `git init` if `.git` doesn't exist; (2) write `.gitignore` covering `.env`, `.env.*` (except `!.env.example`), `.env.local`, `*.pem`, `*.key`, `node_modules`, `.next`, `screenshots/`, `coverage/`, `playwright-report/`, local MinIO/Postgres volumes; (3) run `git check-ignore .env` and `git status --porcelain` and confirm `.env` isn't listed; (4) only then stage and make the first commit; (5) add the pre-commit secret check. Then: Next.js + TS strict, ESLint, Vitest, Playwright + axe. Docker Compose (Redis, MinIO; `postgres-test` for automated tests, §10). Prisma schema + first migration against the **dev** Supabase project, RLS/revoke migration, constraints. Adapter interfaces + mocks (all six) + StorageProvider for Supabase and MinIO. Settings service + default version. Audit + outbox + worker skeleton. Tailwind theme, font, design-rule checker (3 layers), base components (Button, Input, Select, OptionTile, SegmentedControl, Dialog, Sheet, Toast, Tooltip, Skeleton, ProgressBar, Badge, Price, PartNumberText, EmptyState, ErrorState, PermissionDenied), TopBar/BottomBar shell, `/health`, PWA manifest + offline page, `/dev/components` gallery page (dev only). Seed per §11 (fictional Sample Motors catalogue, `SAMPLE-` part numbers, all categories, sample users per role, sample listings in every status). Migrations applied to the Supabase **dev** project and the local test Postgres only. README v1. | Test-DB guard (§10), RLS test, design-rule tests (incl. a deliberately bad fixture that must fail), component a11y, seed idempotency, money/date formatting. |
| **2** | Sign-in, consent, profile, garage | OTP flow with rate limits, sessions, consent capture (versioned), about-you, add bike (skippable), return-to, account, addresses, privacy page, garage CRUD with primary, RBAC wrappers + the "every action is wrapped" test. | Session security, rate limit, RBAC matrix, e2e sign-in on both widths. |
| **3** | Catalogue, part numbers, interchange, admin import | Admin CRUD for makes/models/variants/part numbers/categories; CSV import with validate → report → apply (dry run first); interchange service (groups, safety-critical filtering, modification one-hop); admin interchange queue; "Suggest an equivalent part number"; part-number page (read-only listings list stubbed until M6). | Graph traversal (cycles, supersession chains, safety filter, no transitive mods), normalisation, CSV validation. |
| **4** | Listing wizard and photo upload | 7 steps with autosave + per-step validation, category checklist → grade, part-number vehicle suggestions, signed uploads, image processing job (EXIF strip, blur, brightness, pHash), on-device quality warnings, contact-detail inline warning, comparable price range, review preview, payout-ACTIVE guard for delivery listings (reads `PayoutAccount.status`; seeded sample sellers have mock ACTIVE accounts, and the onboarding UI arrives in M8, so until then only seeded sellers can submit delivery listings), seller dashboard listings-by-status. | EXIF GPS removed (fixture with GPS), blur/brightness maths, grade derivation, wizard e2e. |
| **5** | Risk pipeline and routing | Stage 1 rules, Stage 2 via mock vision, scoring, routing, inspection requirement + trust label, status screen with polling, changes-requested with Fix links, admin listing review queue, settings versioning UI for risk rules. | One test per rule, routing table tests, idempotent job, version recorded. |
| **6** | Search, listing detail, fit bar, part-number pages | Home (vehicle selector, garage parts, recent), search (filters, sort, grid/list, empty state, save search + alerts job), listing detail (7/5 desktop, sticky panel, mobile sticky bar), fit status bar all 5 states, tiles with fit line, part-number page listings, seller profile, saved listings, report listing, static pages. Pincode distance per Q3 / A-24. | fitStatus unit matrix, search by vehicle/part number integration, e2e + screenshots of every fit bar state. |
| **7** | Messages | One thread per listing per buyer, inbox, pinned listing summary, polling, masking with inline note, report message, rate limit, notifications. | Masking regex suite (phones incl. spaced digits and words, emails, UPI), access control. |
| **8** | Checkout, payments, order state machine | Pricing service, checkout flow (address, serviceability/quote via mock shipping, Partner Check line, breakdown), order state service (all transitions + audit + outbox), mock PaymentProvider end to end, webhooks with idempotency, timers (payment TTL, seller confirm), refunds, payout onboarding UI, then the **Cashfree Easy Split sandbox adapter** after reading the docs, reconciliation job + admin page. | Transition table exhaustive tests, duplicate/out-of-order/bad-signature webhook tests, pricing and refund-allocation property tests (§7.5 guarantees, one-fee invariant), refund-before/after-settlement tests, deadline job tests, sandbox contract tests. Cashfree adapter only after reading the official docs and receiving sandbox keys. |
| **9** | Seller order handling and shipping | Orders to handle (confirm with countdown, pickup slot, packaging guide), mock ShippingProvider booking + tracking webhooks, order page timeline + tracking, local-pickup handover flow, buyer cancellation rules. | Tracking webhook idempotency, timeline rendering, e2e seller confirm → delivered. |
| **10** | Mechanic portal and inspections | Assignment, slots/capacity, jobs list, job detail, inspection form (checklist, photos, measured values, outcome, notes), optional check at checkout, audit selection, fail → cancel + refund + CHANGES_REQUESTED, Partner Check label, history/earnings, admin mechanics pages. | Assignment capacity, audit determinism, fail path end to end. |
| **11** | Acceptance, disputes, returns, reviews | Acceptance window + countdown, confirm/report, dispute flow with evidence photos, seller response, admin resolution (refund with return shipment / release), fitment learning, deadline watch + escalation, reviews both directions. | Timeout → COMPLETED, deadline alert, flagged-count updates, review only after COMPLETED. |
| **12** | Admin dashboards, agreement, export, audit | Overview metrics, orders/disputes/reports/users admin, agreement dashboard (automated decision vs mechanic outcome per category: confusion counts, false-pass rate = automated SCREENED/LIVE-no-flag but mechanic FAIL ÷ inspected, sample size), training-data CSV export (streamed; listing → photos (keys + quality metrics) → RiskAssessment → Inspection → order outcome/dispute reason; sample data excluded by default), audit log viewer. | Export column contract test, agreement maths tests. |
| **13** | Accessibility, e2e, performance, hardening | Full axe sweep, keyboard walkthroughs, complete e2e journeys (buyer, seller, mechanic, admin), Lighthouse/PWA check, image sizes, query indexes review, security review (headers/CSP, rate limits, signed URL TTLs, secret scan), README final. | Full suite green on both widths. |

---

## 10. Test strategy [decision D-7]

| Layer | Tool | Runs against | Covers |
|---|---|---|---|
| Unit | Vitest | No DB (pure functions, in-memory adapters) | Pricing and refund allocation (incl. property tests of the one-fee invariant), state transition tables, risk rules, grade derivation, interchange traversal on fixture graphs, fit status matrix, masking regexes, formatting, design-rule checker (with a deliberately bad fixture that must fail), env/secret-exposure checks. |
| Integration | Vitest | **Local Postgres container** (`postgres-test` in Docker Compose, same major version as Supabase), local Redis, in-memory/MinIO storage, mock providers | Services with real SQL: migrations apply cleanly, RLS/no-policy check, CHECK constraints, transitions with audit + outbox, webhook idempotency and signature rejection, job handlers, CSV import, search queries. Each test file runs in a fresh schema or a truncated DB. |
| End-to-end | Playwright + axe | `next build && next start` + worker, against the local test Postgres seeded with SAMPLE data, all mock providers | User journeys, permission-denied paths per role, rendered design-rule check, accessibility, screenshots at 375 and 1440. |
| Provider contract | Vitest | Recorded Cashfree **sandbox** fixtures (M8) | Request/response and webhook mapping; the optional live sandbox run is manual and needs sandbox keys only. |

**Safety guard:** `tests/setup/assert-test-db.ts` runs before every integration and e2e suite. It aborts unless the database host is `localhost`/`127.0.0.1`/the compose service name and the DB name ends in `_test`. The Supabase dev project can never be used as a disposable test database, and nothing in the test path reads `DATABASE_URL` from `.env`; tests use `TEST_DATABASE_URL`.

**Development data:** `prisma migrate dev` and the seed run against the Supabase dev project only when invoked explicitly (`npm run db:migrate`, `npm run db:seed`). The seed is idempotent, touches only rows with `isSample = true`, and refuses to run when `NODE_ENV=production`.

---

## 11. Seed data [decision D-4]

- **Vehicles (fictional):** make **Sample Motors** with models such as *Sample Motors Street 150* (motorcycle), *Sample Motors Roadster 200* (motorcycle) and *Sample Motors City 125* (scooter), each with a few variants and year ranges, plus a second fictional make so interchange across brands can be shown. All carry `isSample = true`.
- **Part numbers (fictional):** format `SAMPLE-<category>-<nnnn>` (e.g. `SAMPLE-BRK-0012`), brands "Sample Motors" (OEM) and "Sample Aftermarket" (non-OEM). The format can't collide with a real manufacturer number, and normalisation keeps the `SAMPLE` prefix.
- **Interchange and fitments:** only between sample part numbers and sample vehicles, covering every link type, source and status, a supersession chain, a FITS_WITH_MODIFICATION link with notes, and a safety-critical case where a BRAND_CROSS_REFERENCE link must *not* count.
- **Categories:** all categories from §6 with default tiers, realistic yes/no checklists, photo guides, packaging guides and part-number hints written as generic guidance ("usually stamped on the back plate"), not as claims about a specific real model. Thresholds and fees are illustrative defaults marked as such in admin.
- **Users and listings:** sample users for every role (members, a seller with a mock ACTIVE payout account, a seller without one, mechanics at a sample garage, an admin), sample listings in every listing status and sample orders in representative order states. Phone numbers use a reserved fake range, prices are illustrative, and text says it is sample content.
- **Visible marking:** any `isSample` record shows a "Sample" badge in the UI, the admin catalogue can filter by it, and the training-data export excludes sample rows by default.
- **Real data** (real makes, models, part numbers, fitments) only enters through admin CSV import from a source the project provides. The seed never contains any.

---

## 12. Deployment requirements [decision D-8]

No hosting provider is chosen; the brief doesn't specify one. Any platform that meets these requirements works:

| Component | Requirements |
|---|---|
| Web app (Next.js) | Node.js runtime (not edge) for server actions and route handlers, because Prisma, `sharp` and webhook raw-body verification need it. Can be serverless or containers. HTTPS. Outbound access to the database pooler, Redis, Storage and provider APIs. Webhook routes must receive the raw request body. Env vars injected by the platform's secret store. |
| Worker (BullMQ) | A **persistent, long-running** Node process (container or VM, ≥1 instance, auto-restart, graceful shutdown on SIGTERM), same code and env as the web app, `sharp` native binaries. Runs all queues and repeatable jobs (timers sweeper, deadline watch, reconciliation, saved-search alerts), so no external cron is needed. Serverless functions aren't suitable. |
| Redis | Persistent Redis reachable over TCP from the web app and worker (BullMQ needs a real Redis connection, not an HTTP-only API), `maxmemory-policy noeviction`, TLS and auth, AOF persistence recommended, in or near India. Job payloads hold ids only, no personal data **[assumption A-13]**. |
| Database | Separate Supabase **production** project in Mumbai, created by the owner later. Runtime uses the pooler URL; `prisma migrate deploy` runs once per release from CI/deploy with `DIRECT_URL` before the new web and worker versions roll out. RLS check runs after migrate. Backups/PITR per Supabase plan. |
| Storage | Supabase Storage private buckets (`listing-photos`, `inspection-photos`, `dispute-evidence`, `catalogue-imports`) in the same project, signed URLs only, and a lifecycle rule or job that deletes unprocessed `incoming/` objects after 24 h. |
| Observability | JSON logs shipped from web and worker; `/api/health` for uptime checks; alerting on worker downtime and on queue backlog. If the worker is down, timers and deadline alerts stop, so this matters. |

---

## 13. Environment variables
`.env.example` (empty placeholders only, committed) will list: `DATABASE_URL`, `DIRECT_URL`, `TEST_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` (optional, RLS smoke test only), `STORAGE_PROVIDER`, `STORAGE_BUCKET_*`, `MINIO_*`, `REDIS_URL`, `SESSION_SECRET`, `OTP_PROVIDER`, `PAYMENT_PROVIDER=mock`, `CASHFREE_APP_ID=`, `CASHFREE_SECRET_KEY=`, `CASHFREE_ENV=sandbox`, `MOCK_WEBHOOK_SECRET`, `SHIPPING_PROVIDER`, `SHIPPING_WEBHOOK_SECRET`, `VISION_PROVIDER`, `NOTIFICATION_PROVIDER`, `APP_BASE_URL`, `LOG_LEVEL`.

Current `.env` (variable **names** checked, values never read or printed): `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. That is enough for M1–M7. At M1 I'll add the missing local values to `.env`: a randomly generated `SESSION_SECRET` and `MOCK_WEBHOOK_SECRET`, and the local Redis, MinIO and test-Postgres URLs. I won't change the existing Supabase values, and the file is never committed. Cashfree keys aren't needed until M8.

---

## 14. Decisions, open questions and assumptions

### 14.1 Owner decisions applied (revision 2)
| # | Decision | Where applied |
|---|---|---|
| D-1 | The Supabase project in `.env` is the **development** project (Mumbai). Development only; never production. | §1.2, §10, §12 |
| D-2 | M1 initialises git with `.gitignore` in place before the first commit; secrets never committed. | §9 M1, §1.2 |
| D-3 | One platform fee per transaction, deducted from the seller's settlement. | §7.1, §7.5, §2 constraints |
| D-4 | Fictional sample vehicles and part numbers; no real fitment claims. | §11 |
| D-5 | Hard failures → CHANGES_REQUESTED; passing listings go LIVE; high-risk ones also enter the admin review queue. | §6.1 |
| D-6 | No automatic refund near the provider auto-release deadline; store, surface and escalate, with explicit admin resolution. | §5.3 |
| D-7 | Local Postgres container for automated tests; the Supabase dev DB is never a disposable test DB. | §10 |
| D-8 | Architecture supports a persistent worker + Redis; no hosting provider chosen yet. | §12 |
| D-9 | Cashfree isn't configured or asked for until M8; mock provider first; sandbox only; official docs first. | §7.4, §13 |
| D-10 | Q1 → **Model S.** One platform fee. Buyer total = item + delivery + check fee. Seller payout = item − platform fee. Merchant share = delivery + check fee + platform fee. The buyer breakdown shows the fee as "deducted from seller payout", not added to the total. | §7.1 |
| D-11 | Q2 → For M4, photo-guide examples are clearly labelled SAMPLE placeholders until real approved examples are supplied. No invented real-world photos or data. | A-23 |
| D-12 | Q3 → For M6, a small clearly labelled SAMPLE `PincodeGeo` dataset for development. No real dataset sourced yet. | A-24 |
| D-13 | M4 → A listing requires an existing catalogue `PartNumber` to be submitted (Step 2 of the listing wizard). This replaces the brief's "optional part number" (§9 Selling, Step 2) for M4. A number that isn't in the catalogue can't be used; sellers are told to check the number. Listings without an identified part number are a future enhancement (§14.1.1), not live. | §4.4, §6.6, §9 M4 |

#### 14.1.1 Future enhancement: sellers who don't know the part number (not implemented)
Recorded with D-13. **Status: planned only.** Nothing in M4 implements it: no unidentified-part flow, schema, UI or tests.

- **Now (M4):** Step 2 requires an existing catalogue part number before the listing can be submitted (L1/L2 guards).
- **Later:** a seller may mark "I don't know the part number" and provide what they have (category, bike, description, photos, markings).
- **No bypass:** such a listing must not skip catalogue identification or the fitment safety rules (§6.6, safety-critical filtering). It stays out of normal publication until a catalogue part number is identified.
- **Human identification:** a mechanic or admin identifies or confirms the catalogue `PartNumber` (adding it to the catalogue through the M3 admin flow if needed). The listing then continues through the normal submit → screening path.
- **AI suggestions:** automated identification (e.g. through the `VisionProvider` adapter) may be considered later as a suggestion only, with human confirmation where appropriate. It never sets the part number on its own.
- **Milestone fit:** designed to integrate with the mechanic portal in M10 (assignment, job list, job detail). Scheduling is to be decided when M10 is planned; it needs an owner decision on schema and states before any build.

### 14.2 Open questions (only ones that need your decision)

**All three resolved by the owner. See D-10, D-11 and D-12 in §14.1. Kept below for context.**
1. **Q1: confirm the fee model (needed before M8; does not block M1–M7).** The worked example in decision D-3 charges the fee twice (see §7.1). I've planned **Model S**: buyer pays ₹10,500, seller receives ₹9,700, platform keeps one ₹300 fee. This follows the brief's "item price minus the platform fee goes to the vendor" rule. If you instead want the buyer to pay the fee (buyer ₹10,800, seller ₹10,000), that's Model B, which contradicts §3 of the brief, so I'd need you to confirm that override explicitly.
2. **Q2: example photos for the photo guide (needed at M4).** §9 asks for "a visual example of each shot", but §10 bans stock photos and illustrations, and §0 bans invented data. Until you supply real example photos, each shot shows a plain framed placeholder with written framing instructions **[assumption A-23]**. Will you provide real example photos per category later?
3. **Q3: pincode location data (needed at M6).** The distance filter and "nearest" sort need pincode coordinates. Is there an official or licensed India pincode dataset you want used? Until then a small SAMPLE `PincodeGeo` table is seeded, and distance is hidden for unknown pincodes **[assumption A-24]**.

### 14.3 Assumptions register (brief is silent; defaults chosen, all changeable)
| # | Assumption | Why |
|---|---|---|
| A-1 | Order state `AWAITING_HANDOVER` for local-pickup orders between seller confirmation (or inspection pass) and the buyer confirming handover. | §7 names no state for this stretch. |
| A-2 | `Fitment.verdict` (FITS / DOES_NOT_FIT), set by admins or by upheld DOES_NOT_FIT disputes. | The §10 "Known not to fit" bar needs negative data the §5 model lacks. |
| A-3 | `PartCategory.optionalCheckEnabled` flag. | §6 Tier A "if the admin enables it for the category" needs a field. |
| A-4 | Required checks charge the category's `optionalCheckFee` to the buyer as the Partner Check line; garages are paid off-platform. *Caveat:* §9's "included" could mean "at no extra charge". If so, the fee becomes ₹0 for required checks and is absorbed by RePart. | Brief doesn't say who pays for required checks or how garages are paid. |
| A-5 | Default buyer-cancellation table: full refund before an inspection or pickup has happened; after a completed inspection, everything except the check fee. Admin-editable. | §7 says "per admin-configured rules" without defaults. |
| A-6 | Local-pickup listings can publish without an ACTIVE payout account (brief only restricts delivery listings), but "Buy now" is disabled until the seller is ACTIVE. | Seller share can't be split without a vendor. *Replaces revision 1's proposal, which went beyond the brief.* |
| A-7 | The platform fee is returned in proportion to the item amount refunded. Return shipping on RESOLVED_REFUND is RePart's cost, not a seller charge. | Keeps "one fee" true under refunds; avoids inventing a seller charge. |
| A-8 | Post-settlement refunds are funded by the merchant, with a `SellerRecovery` record for manual recovery. | Provider can only reverse held funds; automatic recovery to be checked at M8. |
| A-9 | The auto-release clock starts at payment; the length is a setting (default 45 days, from the brief). | Both to be verified in Cashfree docs at M8. |
| A-10 | The deadline panel also lists paid, non-terminal, non-disputed orders within 7 days of auto-release. It only surfaces them and changes no state. | Protects "held until the buyer accepts"; beyond the brief's DISPUTED-only requirement. |
| A-11 | Failed delivery or RTO → admin confirms → CANCELLED with a full refund; listing back to LIVE when returned. | §7 has no failure branch. |
| A-12 | Required inspection with no partner garage serving the pincode: listing stays LIVE, "Buy now" disabled with an explanation, admin alerted. | Brief silent. |
| A-13 | Redis job payloads carry ids only (no personal data). | Data-protection hygiene. |
| A-14 | REJECTED only via admin action, or a rule explicitly marked `reject` (none by default). | Routing rules never produce REJECTED. |
| A-15 | A LIVE listing is re-screened on edits to photos, category, part number or checklist, or a price change > 20 %. | Brief silent. |
| A-16 | After RESOLVED_REFUND the listing becomes WITHDRAWN; the seller can relist from a copy. After a seller declines an order, the listing also becomes WITHDRAWN. | Brief silent. |
| A-17 | Grade derivation: score = 100 − Σ weights of "bad" answers; ≥90 LIKE_NEW, ≥70 GOOD, ≥40 FAIR, else FOR_REPAIR; cut-offs admin-editable. | §5 gives weights but no mapping. |
| A-18 | A Partner Check label survives a cancelled order for 30 days unless the listing is materially edited. | Brief silent. |
| A-19 | Admins can grant MECHANIC/ADMIN roles from `/admin/users` (audited). | Brief silent. |
| A-20 | Listing is RESERVED at order CREATED with a 15-minute payment window (setting); expiry cancels and releases it. | Brief silent on when RESERVED starts. |
| A-21 | Audit selection is a deterministic hash of the order id against the audit %. | Reproducible and testable; the brief only sets the %. |
| A-22 | Platform fee rounding: half-up to the nearest paisa. | Brief silent. |
| A-23 | Photo-guide examples are clearly labelled SAMPLE placeholders with written framing instructions until real approved examples are supplied (confirmed, D-11). | §9 vs §10/§0. |
| A-24 | Small clearly labelled SAMPLE `PincodeGeo` dataset for development; no real dataset sourced yet (confirmed, D-12). | §9 needs distance. |
| A-25 | `postgres-test` added to Docker Compose (tests only). | D-7; extends §2's Docker scope (Redis, MinIO). |

### 14.4 Corrections made during the revision-2 quality review
- **Fee accounting:** revision 1 left the fee payer open and made the `totalPaise` constraint conditional. It's now one model with unconditional constraints, a vendor/merchant split invariant and refund portions that add up (§2, §7.1, §7.5).
- **Double fee in the owner's example:** identified and explained, not silently adopted (§7.1, Q1).
- **Local-pickup payout rule:** revision 1 required a payout account for all listings, which is stricter than §3. Corrected (A-6).
- **Dispute deadline:** removed revision 1's automatic refund, which the brief doesn't support (§5.3).
- **Schema drift:** `buyerVehicleId`/`fitPath` were described in §6.6 but missing from `Order`; added. `merchantSharePaise` added to `Order`, portions added to `Refund`, and `SellerRecovery` added.
- **RLS:** now also covers `_prisma_migrations`, default privileges and "no policies exist". Local test Postgres mirrors the Supabase roles so the same SQL runs.
- **Audit:** the list of audited actions is now explicit and the log is append-only (§1.2).
- **Secrets:** env validation, `server-only`, the `NEXT_PUBLIC_` exposure test, log redaction and the pre-commit check are now explicit (§1.2).
- **Tests:** a strategy table was missing; added with a guard against non-local test databases (§10).
- **Sample data:** made explicit, including a part-number format that can't be mistaken for real (§11).
- **Deployment:** requirements documented without choosing a provider (§12).
- **Resolved revision-1 questions:** the old items on high-risk routing, test DB, hosting, env rename and dev-project confirmation are closed by D-1…D-9. The rest became assumptions above.

### 14.5 Notes
- The `CLAUDE.md` in the parent folder (`sprint-3/`) describes a different project (an internal chat tool) and is ignored for RePart.
- Web access failed during planning, so Cashfree's docs haven't been read yet. §7.4 names no endpoints or fields, and the docs are read at M8 before the adapter is written. Prisma/Tailwind/Next.js/Supabase config details in §1, §2 and §8 are confirmed against current docs at the start of M1.
