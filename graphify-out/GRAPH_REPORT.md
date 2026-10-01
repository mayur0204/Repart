# Graph Report - Repart  (2026-09-30)

## Corpus Check
- 224 files · ~111,531 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 14 file(s) not represented in the graph (top: (none) 10, .example 1, .css 1)

## Summary
- 1522 nodes · 4653 edges · 75 communities (65 shown, 10 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 43 edges (avg confidence: 0.88)
- Token cost: 154,666 input · 0 output

## Community Hubs (Navigation)
- UI Primitives & Gallery
- Sign-in & Consent Flow
- Forms & Admin Pages
- Listing Service & Tests
- Sell Wizard Pages
- SAMPLE Seed Data
- Public Listing Pages
- Display & Status Pages
- Action/Route Wrappers
- Design & Wrap Rule Checks
- Env, DB & Health
- Outbox & Worker
- Buttons & Garage Forms
- Catalogue Admin CRUD
- Public Search Services
- CSV Import
- Photos, Audit & Transitions
- Admin Server Actions
- Interchange Service
- Versioned Settings
- Tooling Config
- Prisma Client & DB Tests
- Listing Helpers & Steps
- OTP Sign-in & Sessions
- Garage & Addresses
- Shipping Adapter
- TypeScript Config
- Storage Adapters
- Mock Adapters Tests
- Member Pages
- Next.js Page Guards
- Categories & CSV Parser
- npm Scripts
- Photo Upload & Quality
- Search Engine
- Interchange Graph Rules
- Service Bindings
- Dev Dependencies
- Runtime Dependencies
- Risk Stage Rules
- Risk Routing & Trust
- Vision Adapter
- Test DB Safety
- Risk Pipeline Job
- Public Detail & Geo
- Notification Adapter
- State Machines & Outbox (Plan)
- Money Model (Plan)
- Architecture Overview (Docs)
- Risk Pipeline (Docs)
- Inspection & Trust (Docs)
- Adapters & Idempotency (Docs)
- Rate Limiting
- Listing State & Audit
- Fit Status
- Payment Provider Interface
- Test Infra & Deployment (Docs)
- Interchange & Fitment (Docs)
- Design System (Docs)
- Data Model & Orders (Docs)
- Cashfree & Deadlines (Docs)
- Formatting Helpers
- Listing Lifecycle (Docs)
- Seed Data Decisions (Docs)
- OTP Adapter
- Playwright E2E
- Milestones
- Secrets & Env (Docs)
- Proxy Redirects
- Agent Rules Docs
- PostCSS Config
- App Icon
- Component Gallery Doc

## God Nodes (most connected - your core abstractions)
1. `Page()` - 74 edges
2. `next` - 72 edges
3. `ActionForm()` - 63 edges
4. `NotFoundError` - 55 edges
5. `UserError` - 54 edges
6. `Badge()` - 53 edges
7. `server-only` - 49 edges
8. `FormInput()` - 39 edges
9. `InlineAction()` - 37 edges
10. `cn()` - 36 edges

## Surprising Connections (you probably didn't know these)
- `HowItWorksPage()` --calls--> `Page()`  [EXTRACTED]
  app/how-it-works/page.tsx → src/components/layout/page.tsx
- `restoreSeededSettings()` --calls--> `seed()`  [EXTRACTED]
  tests/integration/settings.test.ts → prisma/seed/seed.ts
- `External service adapters (mock implementations)` --implements--> `NotificationProvider`  [INFERRED]
  README.md → REPART_BRIEF.md
- `External service adapters (mock implementations)` --implements--> `OtpProvider`  [INFERRED]
  README.md → REPART_BRIEF.md
- `External service adapters (mock implementations)` --implements--> `ShippingProvider`  [INFERRED]
  README.md → REPART_BRIEF.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **State change write pattern (transition + audit + outbox in one transaction)** — plan_state_transition_services, plan_audit_log, plan_transactional_outbox, plan_timers [EXTRACTED 1.00]
- **Six external service adapters** — repart_brief_otpprovider, repart_brief_paymentprovider, repart_brief_shippingprovider, repart_brief_visionprovider, repart_brief_storageprovider, repart_brief_notificationprovider [EXTRACTED 1.00]
- **One-fee money model and refunds** — plan_model_s_fee, plan_pricing_quote, plan_refund_allocation, plan_seller_recovery, plan_d_10 [EXTRACTED 1.00]

## Communities (75 total, 10 thin omitted)

### Community 0 - "UI Primitives & Gallery"
Cohesion: 0.07
Nodes (57): ChoiceDemo(), OverlayDemo(), ComponentsGallery(), metadata, Section(), anek, metadata, RootLayout() (+49 more)

### Community 1 - "Sign-in & Consent Flow"
Cohesion: 0.05
Nodes (61): addressFields, createAddress, deleteAddress, grantConsent, id, purpose, requestPersonalData, setDefaultAddress (+53 more)

### Community 2 - "Forms & Admin Pages"
Cohesion: 0.14
Nodes (49): AccountPage(), ImportReportPage(), ImportPage(), metadata, StatusBadge(), MakesPage(), metadata, metadata (+41 more)

### Community 3 - "Listing Service & Tests"
Cohesion: 0.09
Nodes (45): sharp, useRateLimitStore(), Actor, advance(), bikeInput, createDraft(), Db, detailsInput (+37 more)

### Community 4 - "Sell Wizard Pages"
Cohesion: 0.12
Nodes (38): actor(), asArray, confirmPhotoUpload, continueFrom(), continueFromPhotos, listingId, movePhoto, removePhoto (+30 more)

### Community 5 - "SAMPLE Seed Data"
Cohesion: 0.06
Nodes (23): SAMPLE_LINKS, SAMPLE_MAKES, SAMPLE_MODELS, SAMPLE_PART_FITMENTS, SAMPLE_PART_NUMBERS, SAMPLE_PINCODES, SAMPLE_VARIANTS, SampleLink (+15 more)

### Community 6 - "Public Listing Pages"
Cohesion: 0.12
Nodes (33): metadata, SavedListingsPage(), Part(), GaragePage(), Compat(), ListingPage(), Props, Params (+25 more)

### Community 7 - "Display & Status Pages"
Cohesion: 0.09
Nodes (29): Check, metadata, Results, metadata, HelpPage(), metadata, HowItWorksPage(), metadata (+21 more)

### Community 8 - "Action/Route Wrappers"
Cohesion: 0.10
Nodes (24): dynamic, GET, reportListing, toggleSaveListing, suggestEquivalent, saveSearch, zod, normalizeIndianPhone() (+16 more)

### Community 9 - "Design & Wrap Rule Checks"
Cohesion: 0.08
Nodes (25): violations, checkRepo(), checkSource(), codeRules, cssRules, END, EXTENSIONS, lineOf() (+17 more)

### Community 10 - "Env, DB & Health"
Cohesion: 0.11
Nodes (25): dynamic, GET, @prisma/adapter-pg, adapters, client(), db, globalForPrisma, env() (+17 more)

### Community 11 - "Outbox & Worker"
Cohesion: 0.12
Nodes (24): bullmq, pino, bullmqDispatch(), createQueues(), createRedis(), JobName, JobPayload, JOBS (+16 more)

### Community 12 - "Buttons & Garage Forms"
Cohesion: 0.14
Nodes (23): addVehicle, updateVehicle, AddVehiclePage(), metadata, EditVehiclePage(), metadata, HomePage(), AddBikePage() (+15 more)

### Community 13 - "Catalogue Admin CRUD"
Cohesion: 0.11
Nodes (24): slugify(), FieldError, UserError, Actor, audit(), Db, deleteMake(), deleteModel() (+16 more)

### Community 14 - "Public Search Services"
Cohesion: 0.10
Nodes (26): alertSavedSearches(), Db, deleteSavedSearch(), firstName(), getSellerProfile(), listSavedListings(), matchSavedSearches(), MAX_SAVED_SEARCHES (+18 more)

### Community 15 - "CSV Import"
Cohesion: 0.09
Nodes (24): Actor, applyImport(), createImport(), Db, executeOps(), getImport(), IMPORT_COLUMNS, ImportDeps (+16 more)

### Community 16 - "Photos, Audit & Transitions"
Cohesion: 0.13
Nodes (26): MAX_PHOTO_BYTES, NotFoundError, recordAudit(), photoState(), Actor, confirmPhotoUpload(), Db, deletePhoto() (+18 more)

### Community 17 - "Admin Server Actions"
Cohesion: 0.14
Nodes (27): activateSettingsVersion, actor(), ADMIN, applyImport, createLink, createSettingsVersion, decision, deleteCategory (+19 more)

### Community 18 - "Interchange Service"
Cohesion: 0.11
Nodes (24): normalizePartNumber(), listPartNumbers(), partNumberInput, canonicalPair(), wouldCreateSupersessionCycle(), Actor, adminLinkInput, assertLinkAllowed() (+16 more)

### Community 19 - "Versioned Settings"
Cohesion: 0.15
Nodes (23): DEFAULT_SETTINGS, hours, percent, rateLimit, score, Settings, settingsSchema, activateSettingsVersion() (+15 more)

### Community 20 - "Tooling Config"
Cohesion: 0.08
Nodes (24): engines, node, name, private, type, version, eslint, eslint-config-next (+16 more)

### Community 21 - "Prisma Client & DB Tests"
Cohesion: 0.16
Nodes (12): seed(), pg, vitest, VehicleCatalogue, admin, deps, admin, buyer (+4 more)

### Community 22 - "Listing Helpers & Steps"
Cohesion: 0.14
Nodes (20): ChecklistFields(), DetailsFields(), ChecklistAnswers, ChecklistItem, CONTACT_MASK, CONTACT_PATTERNS, detectContactDetails(), GRADE_TEXT (+12 more)

### Community 23 - "OTP Sign-in & Sessions"
Cohesion: 0.16
Nodes (18): createSession(), Db, hashToken(), resolveSession(), revokeSession(), SESSION_TTL_MS, consumeRateLimit(), rateLimitsFromSettings() (+10 more)

### Community 24 - "Garage & Addresses"
Cohesion: 0.13
Nodes (19): createAddress(), Db, deleteAddress(), getAddress(), listAddresses(), MAX_ADDRESSES, setDefaultAddress(), updateAddress() (+11 more)

### Community 25 - "Shipping Adapter"
Cohesion: 0.10
Nodes (14): Paise, BAND_BASE_PAISE, BAND_ETA_DAYS, distanceBand(), MOCK_SHIPPING_SIGNATURE_HEADER, mockQuotePaise(), BookingInput, Parcel (+6 more)

### Community 26 - "TypeScript Config"
Cohesion: 0.09
Nodes (22): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+14 more)

### Community 27 - "Storage Adapters"
Cohesion: 0.19
Nodes (11): server-only, createStorage(), createMemoryStorageProvider(), StoredObject, createMinioStorageProvider(), createSupabaseStorageProvider(), Bucket, DEFAULT_DOWNLOAD_TTL_SECONDS (+3 more)

### Community 28 - "Mock Adapters Tests"
Cohesion: 0.16
Nodes (16): createMockOtpProvider(), MOCK_OTP_CODE, createMockPaymentProvider(), MOCK_SIGNATURE_HEADER, MockOrder, CreateVendorInput, PaymentWebhookEvent, ProviderOrder (+8 more)

### Community 29 - "Member Pages"
Cohesion: 0.17
Nodes (16): EditAddressPage(), metadata, AddressesPage(), metadata, metadata, PrivacySettingsPage(), SavedSearchesPage(), metadata (+8 more)

### Community 30 - "Next.js Page Guards"
Cohesion: 0.12
Nodes (10): LINKS, metadata, ACTION_LABEL, metadata, KIND_LABELS, metadata, NAV, metadata (+2 more)

### Community 31 - "Categories & CSV Parser"
Cohesion: 0.12
Nodes (15): RFC-4180, CsvParseError, CsvRow, csvToRecords(), parseCsv(), SLUG_PATTERN, Actor, categoryInput (+7 more)

### Community 32 - "npm Scripts"
Cohesion: 0.10
Nodes (20): scripts, build, db:generate, db:migrate, db:migrate:status, db:seed, db:test:reset, dev (+12 more)

### Community 33 - "Photo Upload & Quality"
Cohesion: 0.16
Nodes (19): FormAction, Actions, fd(), measure(), Photo, PhotoUploader(), choose(), run() (+11 more)

### Community 34 - "Search Engine"
Cohesion: 0.11
Nodes (15): loadInterchange(), comparablePriceRange(), Db, DISTANCES, emptyResult(), interchangeMemo(), MATCH_ORDER, PAGE_SIZE (+7 more)

### Community 35 - "Interchange Graph Rules"
Cohesion: 0.14
Nodes (14): GraphLink, GraphNode, GROUP_TYPES, InterchangeResult, kindOf(), linkCounts(), Match, MatchKind (+6 more)

### Community 36 - "Service Bindings"
Cohesion: 0.16
Nodes (14): deleteSavedSearch, id, removeVehicle, setPrimaryVehicle, setSearchAlerts, vehicleFields, metadata, metadata (+6 more)

### Community 37 - "Dev Dependencies"
Cohesion: 0.11
Nodes (18): devDependencies, @axe-core/playwright, dotenv, eslint, eslint-config-next, @playwright/test, postcss, prisma (+10 more)

### Community 38 - "Runtime Dependencies"
Cohesion: 0.12
Nodes (17): dependencies, bullmq, ioredis, lucide-react, minio, next, pg, pino (+9 more)

### Community 39 - "Risk Stage Rules"
Cohesion: 0.31
Nodes (16): hammingDistance(), blockingChecklist(), CategoryRules, contactDetails(), duplicatePhotos(), fail(), ok(), perPhoto() (+8 more)

### Community 40 - "Risk Routing & Trust"
Cohesion: 0.17
Nodes (13): dynamic, GET, inspectionRequirement(), RiskPhoto, riskScore(), route(), selectedForAudit(), trustLabel() (+5 more)

### Community 41 - "Vision Adapter"
Cohesion: 0.19
Nodes (10): createMockVisionProvider(), imageHash(), MOCK_VISION_MODEL_VERSION, MockVisionFixture, CategoryResult, DamageResult, OcrResult, Scored (+2 more)

### Community 42 - "Test DB Safety"
Cohesion: 0.24
Nodes (8): dotenv, problems, SECRET_PATTERNS, staged, resetTestDatabase(), assertLocalTestDatabase(), LOCAL_HOSTS, setup()

### Community 43 - "Risk Pipeline Job"
Cohesion: 0.20
Nodes (13): maskContactDetails(), Db, lockStatus(), reasonAndPass(), reasonOf(), RiskDeps, RiskOutcome, runRiskCheck() (+5 more)

### Community 44 - "Public Detail & Geo"
Cohesion: 0.23
Nodes (9): distanceKm(), isPincode(), FIT_TONE, FitInput, fitStatus(), getPublicListing(), fitsFor(), base (+1 more)

### Community 45 - "Notification Adapter"
Cohesion: 0.24
Nodes (7): createMockNotificationProvider(), Sent, DeliveryResult, EmailMessage, InAppMessage, NotificationProvider, SmsMessage

### Community 46 - "State Machines & Outbox (Plan)"
Cohesion: 0.18
Nodes (8): Assumptions register (A-1..A-25), Append-only AuditLog, Mechanic assignment, Order state machine (O1-O25), orderStateService / listingStateService transition(), Stored deadline timers + sweeper, Transactional outbox, recordAudit append-only audit row

### Community 47 - "Money Model (Plan)"
Cohesion: 0.22
Nodes (5): Model S one-platform-fee money model, Provider-agnostic payment flow, pricing.quote() and orderMoneyView(), Refund allocation (pre/post settlement), SellerRecovery

### Community 48 - "Architecture Overview (Docs)"
Cohesion: 0.22
Nodes (9): Architecture: web app + worker sharing services, Own phone-OTP auth with hashed session tokens, RePart build plan (revision 2), defineAction / defineRoute RBAC wrappers, Services layer (all business logic), RePart README (milestone 1 foundation), PWA service worker and /offline page, RePart build brief (+1 more)

### Community 49 - "Risk Pipeline (Docs)"
Cohesion: 0.22
Nodes (10): minio service (optional profile), Photo processing pipeline (EXIF strip, blur, brightness, pHash), Risk check job and rules, Stage 1 rules (REQUIRED_FIELDS, PHOTO_GUIDE, BLUR, DUPLICATE_PHOTO, PRICE_OUTLIER, CONTACT_DETAILS...), Stage 2 vision rules (CATEGORY_MISMATCH, DAMAGE_CONTRADICTION, PART_NUMBER_OCR), Versioned settings (SettingsSchema), RiskAssessment, Listing risk check pipeline (3 stages) (+2 more)

### Community 50 - "Inspection & Trust (Docs)"
Cohesion: 0.22
Nodes (7): Deterministic audit selection, computeInspectionRequirement, Score and route, Trust label computation, Inspection tiers A/B/C and audit, RePart used two-wheeler parts marketplace, Trust labels (Partner Check / Screened by RePart / Seller-declared)

### Community 51 - "Adapters & Idempotency (Docs)"
Cohesion: 0.22
Nodes (9): Adapter layer (interface + mock + real per provider), Webhook and monetary idempotency, Mock PaymentProvider (HMAC-signed fake webhooks), /api/health endpoint, NotificationProvider, OtpProvider, PaymentProvider, Security and operations (rate limits, paise, idempotency) (+1 more)

### Community 52 - "Rate Limiting"
Cohesion: 0.22
Nodes (8): ioredis, rate-limiter-flexible, consumeWithLimit(), limiterFor(), limiters, RateLimit, RateLimitName, Store

### Community 53 - "Listing State & Audit"
Cohesion: 0.24
Nodes (5): AuditEntry, AuditTx, ListingEventName, TRANSITIONS, VERB

### Community 54 - "Fit Status"
Cohesion: 0.20
Nodes (7): FIT_RANK, FitmentFact, FitResult, FitState, SOURCE_RANK, SOURCE_TEXT, Vehicle

### Community 56 - "Test Infra & Deployment (Docs)"
Cohesion: 0.25
Nodes (6): docker-compose.yml (local services), postgres-test service (tmpfs, tests only), redis service (AOF, noeviction), Deployment requirements, Test strategy (unit, integration, e2e, contract), assert-test-db guard

### Community 57 - "Interchange & Fitment (Docs)"
Cohesion: 0.28
Nodes (8): fitStatus() function, Fitment learning via fitPath, Interchange groups (recursive CTE, safety-critical filter), Part-number normalisation, Fitment, Fitment learning (confirmation/flagged counts), InterchangeLink, Part-number interchange

### Community 58 - "Design System (Docs)"
Cohesion: 0.31
Nodes (8): Three-layer design-rule enforcement, Screenshot review per milestone, Tailwind theme tokens (CSS-first), lint:design static design-rule check, Anek Latin typography, Colour tokens (ink, steel, action, fit, caution, danger), Design system, Fit status bar

### Community 59 - "Data Model & Orders (Docs)"
Cohesion: 0.22
Nodes (8): Prisma schema design, Data model requirements, Dispute, Inspection, Order, Order workflow, PartCategory (inspection tier, checklist, photo guide), Roles (Member, Mechanic, Admin, Courier partner)

### Community 60 - "Cashfree & Deadlines (Docs)"
Cohesion: 0.29
Nodes (4): Provider auto-release deadline handling, Cashfree Easy Split adapter (sandbox only), Daily reconciliation job, Cashfree Easy Split (deferred vendor settlement)

### Community 61 - "Formatting Helpers"
Cohesion: 0.32
Nodes (6): dateFormat, formatDate(), formatKm(), km, rupees, rupeesWithPaise

### Community 62 - "Listing Lifecycle (Docs)"
Cohesion: 0.33
Nodes (4): Listing state machine (L1-L15), Future: sellers who don't know the part number, Listing, Listing wizard (7 steps)

### Community 63 - "Seed Data Decisions (Docs)"
Cohesion: 0.33
Nodes (3): Open questions Q1-Q3 (resolved), Fictional Sample Motors seed data, Seed data (SAMPLE only)

### Community 64 - "OTP Adapter"
Cohesion: 0.33
Nodes (3): OtpProvider, OtpSendResult, OtpVerifyResult

### Community 65 - "Playwright E2E"
Cohesion: 0.40
Nodes (3): @axe-core/playwright, @playwright/test, SCREENS

## Knowledge Gaps
- **452 isolated node(s):** `id`, `addressFields`, `purpose`, `metadata`, `metadata` (+447 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 571 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `next` connect `Next.js Page Guards` to `UI Primitives & Gallery`, `Sign-in & Consent Flow`, `Forms & Admin Pages`, `Service Bindings`, `Sell Wizard Pages`, `Public Listing Pages`, `Display & Status Pages`, `Action/Route Wrappers`, `Proxy Redirects`, `Buttons & Garage Forms`, `Admin Server Actions`, `Tooling Config`, `Member Pages`?**
  _High betweenness centrality (0.092) - this node is a cross-community bridge._
- **Why does `vitest` connect `Prisma Client & DB Tests` to `Listing Service & Tests`, `SAMPLE Seed Data`, `Action/Route Wrappers`, `Design & Wrap Rule Checks`, `Env, DB & Health`, `Outbox & Worker`, `Public Search Services`, `Versioned Settings`, `Tooling Config`, `Listing Helpers & Steps`, `OTP Sign-in & Sessions`, `Garage & Addresses`, `Mock Adapters Tests`, `Categories & CSV Parser`, `Interchange Graph Rules`, `Risk Routing & Trust`, `Test DB Safety`, `Public Detail & Geo`, `Formatting Helpers`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Why does `server-only` connect `Storage Adapters` to `Sign-in & Consent Flow`, `Listing Service & Tests`, `Sell Wizard Pages`, `Public Listing Pages`, `Action/Route Wrappers`, `Env, DB & Health`, `Outbox & Worker`, `Catalogue Admin CRUD`, `Public Search Services`, `CSV Import`, `Photos, Audit & Transitions`, `Interchange Service`, `Versioned Settings`, `Tooling Config`, `Prisma Client & DB Tests`, `OTP Sign-in & Sessions`, `Garage & Addresses`, `Shipping Adapter`, `Mock Adapters Tests`, `Next.js Page Guards`, `Categories & CSV Parser`, `Search Engine`, `Service Bindings`, `Vision Adapter`, `Risk Pipeline Job`, `Notification Adapter`, `Rate Limiting`, `Listing State & Audit`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **What connects `id`, `addressFields`, `purpose` to the rest of the system?**
  _452 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `UI Primitives & Gallery` be split into smaller, more focused modules?**
  _Cohesion score 0.06627175120325805 - nodes in this community are weakly interconnected._
- **Should `Sign-in & Consent Flow` be split into smaller, more focused modules?**
  _Cohesion score 0.0528169014084507 - nodes in this community are weakly interconnected._
- **Should `Forms & Admin Pages` be split into smaller, more focused modules?**
  _Cohesion score 0.14043715846994537 - nodes in this community are weakly interconnected._