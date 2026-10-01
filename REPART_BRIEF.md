# RePart — Build Brief for Claude Code

You are building a production web application that will go live in India. Read this entire brief before doing anything.

## How to work
1. Before writing code, write PLAN.md covering: architecture, full database schema, folder structure, route/page map, state machines, and a milestone breakdown. Stop and wait for my approval.
2. After approval, build one milestone at a time. At the end of each milestone:
   - run the tests
   - take Playwright screenshots of every new screen at 375px and 1440px widths
   - review the screenshots against the Design System section below and fix what doesn't match
   - summarise what was built and what is unfinished, then stop for my review
3. Never invent real-world data (part numbers, fitments, prices, company names). Use clearly marked SAMPLE data.
4. Business logic lives in services, not in React components. All order and payment state changes go through one service that validates transitions and writes an audit log.

---

## 1. Product summary

RePart is a peer-to-peer marketplace for used motorcycle and scooter parts in India (all bike types at launch; cars later, so the vehicle model must not assume two wheels). Individuals list parts; buyers find parts by their own vehicle or by part number.

Around each sale RePart adds:
- guided, structured listings
- part-number cross-referencing (interchange)
- an automated listing risk check
- inspection by partner mechanics, based on inspection tiers
- payment held until the buyer accepts delivery
- delivery through partner couriers

Never describe anything to users as "certified", "guaranteed" or "verified quality". The only trust labels are:
- **RePart Partner Check:** "Inspected by [garage] on [date]. Visual and basic check."
- **Screened by RePart:** passed automated checks.
- **Seller-declared:** everything else.

---

## 2. Tech stack

- Next.js (App Router) + TypeScript (strict)
- Tailwind CSS with a custom theme (see Design System). Radix UI primitives may be used for accessibility behaviour only, styled from scratch; do not use a pre-styled component kit's default look.
- PostgreSQL hosted on Supabase (Mumbai region), accessed only through Prisma
- Supabase Storage for all photos (listing, inspection, dispute), behind the StorageProvider interface
- Redis + BullMQ for background jobs
- Zod validation on every input; role-based access control on every route, server action and API handler
- Vitest (unit), Playwright (end-to-end and screenshots)
- Docker Compose for Redis locally, plus MinIO as an optional offline StorageProvider implementation
- Mobile-first, installable PWA

### Supabase rules
- **Prisma connections:**
  - DATABASE_URL is the Supabase pooled connection string, used by the app at runtime.
  - DIRECT_URL is the direct connection string, used for migrations.
  - Add both to .env.example with placeholder values.
- **Migrations:** manage the schema only through Prisma migrations, never through the Supabase dashboard.
- **Server-only data access:**
  - Do NOT use Supabase Auth, and do NOT use Supabase client-side database access from the browser.
  - All data access goes through our server with Prisma and our own role checks.
  - Enable Row Level Security with no public policies on every table, so the public API cannot read or write anything.
- **Keys:** the Supabase service-role key is used only server-side (for Storage) and must never reach the browser or be committed.
- **Storage buckets:** private only. Photos are served through short-lived signed URLs.
- **Environments:** separate Supabase projects for development and production. I will put the development credentials in .env. If they are missing, stop and ask; do not create or modify any production project.

## 3. External services: adapters with mock implementations

Define a TypeScript interface for each service, with a working mock used in dev and tests. No provider SDK calls outside its adapter. Real providers will be plugged in later.

1. **OtpProvider:** send and verify phone OTP.
2. **PaymentProvider:** create order, capture, hold, release to seller (marketplace payout), partial and full refund, seller payout onboarding status, webhook signature verification.
3. **ShippingProvider:** pincode serviceability, rate quote by weight and dimensions, book pickup, tracking webhooks, cancel, return shipment.
4. **VisionProvider:** part-category classification with confidence, visible-damage detection with confidence, OCR.
5. **StorageProvider:** signed upload and download URLs. Implementations: Supabase Storage (default) and MinIO (offline development).
6. **NotificationProvider:** SMS, email and in-app (WhatsApp later).

All webhook handlers must be idempotent.

### PaymentProvider: Cashfree (first real implementation)
Build the mock first, then a Cashfree implementation of the same interface, using Cashfree Payment Gateway with **Easy Split**. Read Cashfree's current official API documentation before implementing; do not rely on memory for endpoints or field names.

**Sellers as vendors**
- Each seller becomes a Cashfree Easy Split vendor. Payout onboarding in the seller dashboard creates the vendor with bank account verification enabled.
- A seller cannot publish a listing for delivery until their vendor status is active. Drafts are still allowed.
- Store only the Cashfree vendor ID and status, never raw bank details.

**Holding funds until the buyer accepts**
- Use deferred vendor settlement, so the seller's share is held after payment.
- When an order reaches COMPLETED, call Cashfree's API to make the vendor settlement eligible now.
- Cashfree automatically releases deferred funds after its maximum hold period (45 days at the time of writing):
  - Store each order's auto-release deadline.
  - Show admins any order that is DISPUTED and within 7 days of that deadline.
  - Never let a dispute pass the deadline unresolved.

**Splits and refunds**
- Our share (platform fee, delivery fee, check fee) stays with the merchant account; the item price minus the platform fee goes to the vendor.
- Refunds for cancellations, failed inspections and resolved disputes go through Cashfree's refund API. Handle both cases: refund before the vendor split is settled, and refund after.

**Webhooks and testing**
- Verify every webhook signature (payment success, payment failure, refunds, vendor settlement).
- Reconcile orders against Cashfree's settlement data in a daily background job, and show mismatches in admin.
- Use Cashfree sandbox credentials in development. All keys come from environment variables (CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV).

---

## 4. Roles

- **Member:** one account can both buy and sell.
- **Mechanic:** partner garage staff.
- **Admin.**
- **Courier partner:** webhook identity only, no UI.

---

## 5. Data model (requirements; design fully in PLAN.md)

**Users and consent**
- **User:** verified phone, name, roles, status.
- **Address:** with pincode.
- **ConsentRecord:** purpose, version, timestamp. Required at signup under India's data protection law.
- **PayoutAccount:** provider reference and onboarding status only. Never store raw bank details.

**Vehicle catalogue**
- **VehicleMake → VehicleModel → VehicleVariant:** year ranges, vehicleType (MOTORCYCLE, SCOOTER; extensible to CAR).
- **UserGarage:** a user's saved vehicles, with one marked primary.

**Categories**
- **PartCategory:** hierarchical. Fields:
  - isSafetyCritical
  - inspectionTier: A_AUTOMATED | B_CONDITIONAL | C_ALWAYS
  - inspectionValueThreshold (paise)
  - optionalCheckFee (paise)
  - shippingRestriction: NONE | FRAGILE | OVERSIZE | NOT_SHIPPABLE
  - packagingGuide (text)
  - partNumberHint: where the number is usually printed
  - conditionChecklist: JSON array of yes/no questions, each with a weight and a flag for whether a "bad" answer blocks listing
  - photoGuide: the required shots for this category

**Part numbers and fitment**
- **PartNumber:** number (normalised: uppercase, spaces and dashes stripped for matching; original kept for display), brand, isOem, category.
- **InterchangeLink:**
  - partNumberA, partNumberB
  - type: EXACT_EQUIVALENT | SUPERSEDED_BY | FITS_WITH_MODIFICATION (notes required for the last)
  - source: OEM_CATALOGUE | BRAND_CROSS_REFERENCE | MECHANIC_CONFIRMED | ADMIN | USER_SUBMITTED
  - status: PENDING | APPROVED | REJECTED
  - confirmationCount, flaggedCount, notes
- **Fitment:** links a PartNumber or a Listing to VehicleVariants, with source: PART_NUMBER_MATCH | MECHANIC_CONFIRMED | BUYER_CONFIRMED | SELLER_DECLARED.

**Listing**
- Fields:
  - seller, vehicle variant(s), category, optional part number
  - title, description
  - checklist answers and the derived conditionGrade: LIKE_NEW | GOOD | FAIR | FOR_REPAIR
  - approximate km used, reason for sale
  - price (paise), pickup address and pincode
  - weight and dimension band
  - photos
- Status machine: DRAFT → SUBMITTED → SCREENING → CHANGES_REQUESTED | REJECTED | LIVE → RESERVED → SOLD | WITHDRAWN. RESERVED returns to LIVE if the order is cancelled.
- **ListingPhoto:** storage key, shot type, perceptual hash, dimensions, blur score, brightness score. Strip EXIF location on upload.

**Checks and inspections**
- **RiskAssessment:** listing, score 0–100, reasons (array of {code, message, severity}), individual check results, ruleSetVersion, visionModelVersion, routing decision, createdAt.
- **MechanicPartner:** garage name, address, service pincodes, active status, capacity per day, quality stats.
- **Inspection:**
  - listing, order, mechanic
  - scheduled slot, done at the seller's location before pickup
  - reason: TIER_C | TIER_B_THRESHOLD | HIGH_RISK | BUYER_OPTIONAL | AUDIT
  - checklist results, photos, measured values
  - outcome: PASS | PASS_WITH_NOTES | FAIL
  - notes, completedAt

**Orders, payments and delivery**
- **Order:** buyer, listing, item price, shipping fee, check fee, platform fee (admin-configurable percentage, default 0), total, state (Section 7).
- **Payment:** amounts, provider references, full event history.
- **Shipment:** provider reference, tracking events, addresses, package details.
- **Dispute:** reason (DOES_NOT_FIT | NOT_AS_DESCRIBED | DAMAGED_IN_TRANSIT | NOT_RECEIVED | OTHER), buyer evidence, seller response, admin resolution, return shipment.

**Trust and admin**
- **Review:** both directions; only after COMPLETED.
- **Report:** for listings, users and messages.
- **Conversation** and **Message:** one conversation per listing per buyer.
- **Settings:** admin-editable, versioned; every change audited.
- **AuditLog.**

**Training data requirement (critical).** Every listing must be traceable end to end:
- photos
- RiskAssessment
- Inspection outcome, if any
- final order outcome: completed, cancelled, or disputed with reason

Provide an admin CSV export of this joined dataset. It will be used to measure how well the automated check agrees with mechanics and to train our own model.

---

## 6. Listing risk check pipeline

This runs as a background job when a listing is submitted. The seller immediately sees "Checking your listing", and uploads never wait for checks.

**Stage 1: rules (always run)**
- required fields present
- category photo guide satisfied, with at least 3 photos
- minimum resolution
- blur (variance of Laplacian) and brightness per photo
- duplicate or copied photos: perceptual-hash match against other listings
- price outlier against comparable listings (skipped when fewer than a configurable number of comparables)
- checklist answers that block listing
- contact details in title or description (phone numbers, emails, UPI handles): mask them and flag

**Stage 2: vision (only if Stage 1 has no hard failures)**
- the photo shows the chosen category
- visible damage contradicts the seller's checklist answers
- OCR'd part number compared with the entered part number

**Stage 3: score and route**
1. Hard failures → CHANGES_REQUESTED, with specific, fixable messages per issue (e.g. "Photo 2 is blurry. Retake it in daylight, holding the phone steady.").
2. Otherwise → LIVE, with the inspection requirement stored on the listing:
   - **Tier C:** Partner Check before every sale.
   - **Tier B:** Partner Check if price ≥ the category threshold or the risk score ≥ the risk threshold. Below that, the buyer is offered an optional Partner Check at checkout, at the category's optionalCheckFee.
   - **Tier A:** no Partner Check. An optional check may be offered if the admin enables it for the category.
   - **Audit:** a configurable percentage (default 5%) of sold orders that would not otherwise be inspected are sent for inspection (reason AUDIT). The buyer is told "This order was picked for a routine quality check" and there is no fee.
3. The trust label follows from this: Partner Check once inspected, Screened by RePart if automated checks passed with low risk, Seller-declared otherwise.
4. Store ruleSetVersion and visionModelVersion. All thresholds, tiers and percentages are admin-editable.

**Default tiers** (admin can change):
- **Tier C:** brake pads, brake discs, brake levers, tyres, wheels, suspension, steering parts.
- **Tier B:** exhausts, clutch parts and clutch levers, engine parts, ECUs and electricals, lights.
- **Tier A:** mirrors, body panels and fairings, seats, grips, accessories.

---

## 7. Order workflow

Order states: CREATED → PAID_HELD → AWAITING_SELLER → [INSPECTION_SCHEDULED → INSPECTION_PASSED] → PICKUP_SCHEDULED → IN_TRANSIT → DELIVERED → ACCEPTANCE_WINDOW → COMPLETED.

Branches:
- Seller doesn't confirm within the configurable window (default 24h) → CANCELLED, full refund, listing back to LIVE.
- Inspection FAIL → CANCELLED, full refund including the check fee. The listing moves to CHANGES_REQUESTED with the mechanic's notes shown to the seller.
- Buyer reports a problem during the acceptance window (default 48h) → DISPUTED → RESOLVED_REFUND (return shipment booked) or RESOLVED_RELEASE.
- No action by the end of the acceptance window → COMPLETED automatically; funds released to the seller minus the platform fee.
- Cancellation by buyer before pickup → refund per admin-configured rules.
- NOT_SHIPPABLE categories: local pickup only. The buyer and seller meet; the buyer confirms handover in-app, which moves the order to ACCEPTANCE_WINDOW.

Fitment learning:
- On COMPLETED with no DOES_NOT_FIT dispute: increment confirmationCount on the interchange links and fitments that connected the buyer's vehicle to the part.
- On a DOES_NOT_FIT dispute: increment flaggedCount and add the link to the admin review queue.

Notifications go out at every state change to the relevant parties.

---

## 8. Part-number interchange

- Build interchange groups by traversing ONLY approved EXACT_EQUIVALENT and SUPERSEDED_BY links.
- FITS_WITH_MODIFICATION links are never traversed transitively and always display their notes.
- For safety-critical categories, only OEM_CATALOGUE and MECHANIC_CONFIRMED links count toward compatibility.
- **Search by part number:** returns listings for the whole group, each labelled with match type and source.
- **Search by vehicle:** resolves the vehicle's part numbers, expands through groups, and includes listings with direct fitments.
- **Listing wizard:** an entered part number suggests compatible vehicles through its group; the seller confirms them.
- **Part-number page:** a public page per part number listing its equivalents, compatible vehicles and live listings.
- **Community input:** users can "Suggest an equivalent part number"; suggestions start as PENDING.

---

## 9. Screens and user flows

### Global navigation
- **Mobile:** bottom bar with Search, Garage, Sell, Messages, Account. Sell is visually primary.
- **Desktop:** top bar with the logo, a search field that accepts a bike or a part number, then Sell a part, Messages, and Account.

### Public
- **Home:**
  - Opens with a working search, not a marketing banner. Two paths: "What do you ride?" (make, model, year selectors) or "Search by part number".
  - If the user has a garage, it shows parts that fit their primary bike.
  - Below that: a short, plain explanation of how checks and delivery work (three sentences, no icons grid), recently listed parts, and a "Sell a part" prompt.
- **Search results:**
  - Filters: category, condition, price, distance, trust label, delivery or pickup.
  - Grid on desktop, list on mobile. Sort options: best fit, newest, price, nearest.
  - Empty results say what to try next (widen distance, search by part number, save the search) and let the user save the search to be alerted.
- **Listing detail:**
  - photo gallery with shot-type captions
  - the fit status bar (Section 10)
  - title, price, condition grade with the checklist answers behind it
  - part number linked to its part-number page, with equivalents
  - km used, reason for sale
  - trust label with what it means
  - seller summary (member since, completed sales, rating)
  - delivery estimate for the user's pincode, and whether a Partner Check is included, optional or not needed
  - actions: Buy now, Message seller, Save, Report
- **Part-number page, seller public profile, "How RePart works" page, Help, Terms and Privacy** (placeholder text marked TODO).

### Sign-in
Phone number → OTP → name and consent (plain-language summary with a link to the full policy) → "Add your bike" (skippable) → return to where the user was.

### Selling: listing wizard
Shows "Step X of 7" with a progress bar. Autosaves as a draft, and each step validates before continuing.
1. **Bike:** pick from garage or search make, model, year.
2. **Part:** category, then part name; optional part number with the category's hint on where to find it. When a number is entered, show the vehicles it fits and let the seller confirm them.
3. **Condition:** the category checklist as simple yes/no questions. Show the resulting grade and what it means.
4. **Photos:** a shot list from the category photo guide, with a visual example of each shot. On-device quality warnings (too dark, blurry) appear before upload.
5. **Details:** km used (approximate), reason for sale, description with a character guide. Warn inline if contact details are typed.
6. **Price and pickup:** price, with the range of comparable listings shown only when there is enough data. Pickup address, weight band, packaging guide for the category.
7. **Review:** full preview exactly as buyers will see it, then Submit listing.

After submitting:
- Status screen "Checking your listing", with a live result.
- Changes requested: each issue is listed with a direct "Fix" link to the right step.

### Seller dashboard
- Listings grouped by status.
- **Orders to handle:** confirm availability (with countdown), inspection appointment, pickup slot with packaging guide, shipment status.
- **Payouts:** status and history, and payout account setup through the payment provider.

### Buying: checkout
Delivery address → serviceability and delivery quote → Partner Check line (included / optional with fee and a one-line explanation / not needed) → price breakdown (item, delivery, check, platform fee, total) → Pay.

Then:
- **Order page:** a vertical timeline of states with the current step clear, plus tracking.
- **After delivery:** "Confirm it's OK" or "Report a problem", with the acceptance window countdown.
- **Report a problem:** reason, photos, description → dispute page showing status and next steps.
- **After completion:** a review prompt.

### Messages
- Inbox, with one thread per listing; the listing summary is pinned at the top of each thread.
- Contact details are auto-masked with an inline note explaining why.
- Report a message.

### Garage
Add and edit bikes, set a primary bike, and see parts that fit each bike. Saved searches with alerts.

### Mechanic portal (mobile-first)
- **Jobs:** today and upcoming.
- **Job detail:** address, time slot, part summary and the seller's photos.
- **Inspection form:** the category checklist, required photos, measured values, outcome and notes → Submit inspection.
- **History and earnings.**

### Admin
- Overview metrics.
- Listing review queue (flagged, high risk).
- Catalogue: makes, models, variants, part numbers, with CSV import and validation reports.
- Interchange review queue.
- Categories: tiers, thresholds, fees, checklists, photo guides.
- Risk rules and settings (versioned).
- Mechanics: onboarding, service areas, capacity, assignment.
- Orders, Disputes (evidence view and resolution actions), Reports, Users.
- **Agreement dashboard:** automated decision versus mechanic outcome per category, with confusion counts, false-pass rate and sample size.
- Training-data export and audit log.

### States every screen must handle
Loading (skeletons matching the final layout, no spinners), empty, error, offline (PWA), and permission-denied.

---

## 10. Design system

### Direction
Professional, calm and trustworthy: a well-run parts counter, not a startup landing page. The part photos and the facts about fit and condition are the content; the interface stays quiet around them.

Visual source of truth: the Stitch project "RePart Auto Marketplace UI" (RePart Design System). Adopted as a hybrid:
Stitch colours, logo, type, shapes and layouts; the quieter rules below still apply.

### Hard rules
- **Corners only from the Stitch radius tokens:**
  - 4px (`rounded-sm`) checkboxes, 8px (`rounded-md`) buttons, inputs and selects, 16px (`rounded-lg`) cards, tiles, images and modals, full (`rounded-full`) badges and pills.
  - No other radius values. Prefer selectable option tiles or segmented controls over radio buttons.
  - The lint and e2e checks fail on any other `rounded` class or radius value.
- **No drop shadows as decoration.** Separate things with 1px rules, background tone and spacing. The only shadow allowed is a single subtle one for floating layers (menus, modals).
- **No gradients, glassmorphism, blobs, stock photos, illustrations or emoji** anywhere in the UI.
- **Avoid these tells:**
  - ALL-CAPS labels or tracked-out eyebrow text above headings
  - meta strings joined with middle dots ("A · B · C")
  - arrows appended to button or link text
  - monospace fonts for small labels
  - 01/02/03 numbering on anything that isn't a real sequence (the wizard steps and order timeline are real sequences)
  - identical feature-card grids
  - fade-and-slide-up entrance animations on sections
  - hover lift animations on cards

### Typography
- **Plus Jakarta Sans** (700–800) for headings, prices and the wordmark; **Inter** for body, labels and data (both Google Fonts).
- Use tabular figures for prices, part numbers and counts. Part numbers get their own style: slightly larger, semibold, with extra letter-spacing, so they read clearly. Do not use monospace for them.
- Type scale (rem): 0.875 / 1 / 1.125 / 1.375 / 1.75 / 2.25. Body 1rem, line-height 1.5; headings line-height 1.15–1.25.
- Keep line length under ~75 characters for body text.
- Sentence case everywhere.

### Colour tokens

| Token | Value | Use |
|---|---|---|
| ink | #0F172A | Primary text, dark panels (deep navy) |
| steel | #626A78 | Secondary text (Stitch #6B7280, darkened for AA on the canvas) |
| rule | #E5E7EB | Borders and dividers |
| page | #FFF7F2 | Page background (warm canvas) |
| surface | #FFFFFF | Panels and tiles |
| brand | #FF6B35 | Primary button fills, always with ink text (white on it fails AA); hover #F25A22; tint #FFEDE4 |
| action | #AB3500 | Links, focus ring, selected state; hover #832600 |
| fit | #006C49 | Fits / passed; tint #E7F8F1 |
| caution | #7A5200 | Unconfirmed / needs attention; tint #FCF1D9 |
| danger | #BA1A1A | Errors, doesn't fit, failed; tint #FFE9E6 |

- Status colours are always paired with text and an icon, never colour alone.
- Everything meets WCAG AA contrast.

### Layout
- Left-aligned content, with a 4px spacing base.
- **Desktop:** 12-column grid, max width 1280px.
- **Listing detail on desktop:** photos on the left (7 columns), facts and actions on the right (5 columns), with the action panel sticky.
- **Mobile:** a single column with a sticky bottom action bar (price + Buy now).

### Signature element: the fit status bar
On listing detail, directly under the title and price, a full-width bar answers "Will this fit my bike?" in plain words. It is the boldest element on the page.

| Situation | Colour | Wording |
|---|---|---|
| Part-number or mechanic match | fit | "Fits your Bajaj Pulsar NS200 (2019)", with the source on a second line, e.g. "Matched by part number" |
| Seller-declared only | caution | "Seller says this fits your Pulsar NS200. Not confirmed by part number." |
| Fits with modification | caution | The modification note shown in full |
| Known not to fit | danger | "Does not fit your Pulsar NS200" |
| No bike in garage | neutral | "Add your bike to check fit", with an inline selector |

On search result tiles, the same status appears as one line of text with an icon.

### Listing tile
- 1px rule border, white surface, square photo, no shadow.
- Content order: fit line, title, condition grade, price (large, tabular), then location and delivery availability on a separate line.
- Hover on desktop darkens the border only.

### Components
- **Buttons:**
  - primary: solid brand orange with ink text
  - secondary: 1px rule border on white, ink border on hover
  - tertiary: text-only with underline on hover
  - minimum 44px tall
  - labels are verbs saying exactly what happens
- **Inputs:** 1px rule border, 44px tall, labels above fields, and help text below. Errors appear under the field in danger colour with a fix.
- **Icons:** one line-icon set at one stroke weight, used only where it aids scanning.
- **Motion:** only in response to user actions (opening a sheet, confirming a step), 150–200ms, and respecting prefers-reduced-motion.

### Formatting
- Prices use Indian grouping: ₹75,000, ₹1,25,000 (Intl en-IN, stored in paise).
- Dates: 28 Sep 2026. Distances in km.

### Writing
- Plain, direct and friendly; no marketing words ("seamless", "unlock", "revolutionary").
- Keep action names consistent: "List part" → "Part listed"; "Submit inspection" → "Inspection submitted".
- Errors say what happened and how to fix it, and never apologise vaguely.
- Empty states tell the user what to do next.
- Explain every trust label and fee in one sentence where it appears.

### Accessibility
- Keyboard navigable, with a visible focus style (2px action-coloured outline).
- Semantic HTML, labelled inputs, alt text on listing photos from the shot type.
- Tested with axe in Playwright.

---

## 11. Security and operations
- Rate limiting on OTP, messages and listing submission.
- Signed image URLs; secrets only via environment variables, with a complete .env.example (Supabase URLs and keys, Redis, and every provider adapter).
- All money stored in integer paise. Monetary operations are idempotent.
- Structured logging, and a /health endpoint.
- README covering setup (including creating the Supabase dev project and running migrations), environment variables, running tests, and how to swap each mock adapter for a real provider.

## 12. Seed data
- A small SAMPLE catalogue, clearly marked in the database and UI: a few makes, models and variants, sample part numbers and sample interchange links.
- All part categories with realistic checklists, photo guides and default tiers.
- Sample users for each role, and sample listings in every status.
- Do not invent real part numbers or real fitments.

## 13. Milestones (refine in PLAN.md)
1. Scaffold, Supabase connection and Prisma migrations, Docker (Redis, MinIO), Tailwind theme with design tokens and the no-radius check, base components, schema, seed.
2. Sign-in, consent, profile, garage.
3. Catalogue, part numbers, interchange, admin CSV import.
4. Listing wizard and photo upload.
5. Risk-check pipeline and routing.
6. Search, listing detail with the fit status bar, part-number pages.
7. Messages.
8. Checkout, payments and the order state machine.
9. Seller order handling and shipping.
10. Mechanic portal and inspections, including optional checks and audits.
11. Acceptance, disputes, returns, reviews.
12. Admin dashboards, agreement metrics, export, audit log.
13. Accessibility pass, end-to-end tests, performance and hardening.
