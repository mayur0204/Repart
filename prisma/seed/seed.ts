/**
 * RePart SAMPLE seed (PLAN.md §11). Idempotent: every row has a deterministic id and is upserted.
 *
 *   npm run db:seed -- --target=test   → local Docker postgres-test (TEST_DATABASE_URL)
 *   npm run db:seed -- --target=dev    → Supabase DEVELOPMENT project (DIRECT_URL)
 *
 * Refuses to run when NODE_ENV=production. Never points at production.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import type {
  ConditionGrade,
  FulfilmentMode,
  InspectionReason,
  InspectionRequirement,
  ListingStatus,
  OrderState,
  TrustLabel,
  WeightBand,
} from "../../src/generated/prisma/enums";
import { normalizePartNumber } from "../../src/lib/part-number";
import { DEFAULT_SETTINGS, settingsSchema } from "../../src/server/services/settings/schema";
import { assertLocalTestDatabase } from "../../tests/setup/assert-test-db";
import { CATEGORIES } from "./data/categories";
import {
  SAMPLE_LINKS,
  SAMPLE_MAKES,
  SAMPLE_MODELS,
  SAMPLE_PART_FITMENTS,
  SAMPLE_PART_NUMBERS,
  SAMPLE_PINCODES,
  SAMPLE_VARIANTS,
} from "./data/catalogue";

/**
 * Consent version given to SAMPLE users. Must equal CONSENT_POLICY_VERSION in
 * src/server/services/consent/consent.ts (not imported: that module is server-only);
 * tests/unit/seed-data.test.ts keeps them in sync.
 */
export const SAMPLE_CONSENT_VERSION = "2026-09-01";

// ───────────────────────────── target & guards ─────────────────────────────

export function resolveSeedTarget(
  argv: string[],
  env: Record<string, string | undefined>,
): { target: "test" | "dev"; url: string } {
  if (env.NODE_ENV === "production") throw new Error("Refusing to seed: NODE_ENV=production.");
  const arg = argv.find((a) => a.startsWith("--target="))?.split("=")[1];
  if (arg !== "test" && arg !== "dev") throw new Error("Pass --target=test (local Docker) or --target=dev (Supabase development).");
  if (arg === "test") {
    const url = env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set.");
    assertLocalTestDatabase(url);
    return { target: "test", url };
  }
  const url = env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set.");
  return { target: "dev", url };
}

// ───────────────────────────── helpers ─────────────────────────────

const json = (value: unknown) => value as Prisma.InputJsonValue;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const rupees = (r: number) => r * 100; // → paise

/** Model S money (PLAN.md §7.1, D-10): one platform fee, deducted from the seller. */
function orderMoney(itemPricePaise: number, shippingFeePaise: number, checkFeePaise: number, platformFeeBps: number) {
  const platformFeePaise = Math.floor((itemPricePaise * platformFeeBps + 5_000) / 10_000); // round half up
  return {
    itemPricePaise,
    shippingFeePaise,
    checkFeePaise,
    platformFeePaise,
    platformFeeBps,
    vendorSharePaise: itemPricePaise - platformFeePaise,
    merchantSharePaise: shippingFeePaise + checkFeePaise + platformFeePaise,
    totalPaise: itemPricePaise + shippingFeePaise + checkFeePaise,
  };
}

// ───────────────────────────── seed ─────────────────────────────

export async function seed(db: PrismaClient, now = new Date()): Promise<void> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const ahead = (ms: number) => new Date(now.getTime() + ms);

  // Settings v1 (active)
  const settings = settingsSchema.parse(DEFAULT_SETTINGS);
  await db.settingsVersion.upsert({
    where: { version: 1 },
    create: { id: "settings-v1", version: 1, data: json(settings), isActive: true, note: "Initial defaults (M1 seed)" },
    update: { data: json(settings), isActive: true },
  });

  // Sample pincodes
  for (const p of SAMPLE_PINCODES) {
    await db.pincodeGeo.upsert({ where: { pincode: p.pincode }, create: { ...p, isSample: true }, update: { ...p, isSample: true } });
  }

  // Categories (parents first)
  const catId = (slug: string) => `cat-${slug}`;
  for (const c of [...CATEGORIES].sort((a, b) => Number(!!a.parentSlug) - Number(!!b.parentSlug))) {
    const data = {
      name: c.name,
      slug: c.slug,
      parentId: c.parentSlug ? catId(c.parentSlug) : null,
      sortOrder: c.sortOrder,
      isSafetyCritical: c.isSafetyCritical,
      inspectionTier: c.inspectionTier,
      inspectionValueThreshold: c.inspectionValueThreshold ?? null,
      optionalCheckFee: c.optionalCheckFee,
      optionalCheckEnabled: c.optionalCheckEnabled,
      shippingRestriction: c.shippingRestriction,
      packagingGuide: c.packagingGuide,
      partNumberHint: c.partNumberHint ?? null,
      conditionChecklist: json(c.conditionChecklist),
      photoGuide: json(c.photoGuide),
    };
    await db.partCategory.upsert({ where: { slug: c.slug }, create: { id: catId(c.slug), ...data }, update: data });
  }

  // Catalogue
  for (const m of SAMPLE_MAKES) {
    await db.vehicleMake.upsert({ where: { id: m.id }, create: { ...m, isSample: true }, update: { ...m, isSample: true } });
  }
  for (const m of SAMPLE_MODELS) {
    await db.vehicleModel.upsert({ where: { id: m.id }, create: { ...m, isSample: true }, update: { ...m, isSample: true } });
  }
  for (const v of SAMPLE_VARIANTS) {
    await db.vehicleVariant.upsert({ where: { id: v.id }, create: { ...v, isSample: true }, update: { ...v, isSample: true } });
  }
  for (const pn of SAMPLE_PART_NUMBERS) {
    const data = {
      display: pn.display,
      normalized: normalizePartNumber(pn.display),
      brand: pn.brand,
      isOem: pn.isOem,
      categoryId: catId(pn.categorySlug),
      isSample: true,
    };
    await db.partNumber.upsert({ where: { id: pn.id }, create: { id: pn.id, ...data }, update: data });
  }
  for (const l of SAMPLE_LINKS) {
    const data = {
      partNumberAId: l.a,
      partNumberBId: l.b,
      type: l.type,
      source: l.source,
      status: l.status,
      notes: l.notes ?? null,
      isSample: true,
      reviewedAt: l.status === "PENDING" ? null : ago(30 * DAY),
    };
    await db.interchangeLink.upsert({ where: { id: l.id }, create: { id: l.id, ...data }, update: data });
  }
  for (const f of SAMPLE_PART_FITMENTS) {
    const data = { partNumberId: f.partNumberId, variantId: f.variantId, source: f.source, isSample: true };
    await db.fitment.upsert({ where: { id: f.id }, create: { id: f.id, ...data }, update: data });
  }

  // Users — phone numbers use a +91 5xxxx prefix, which is not a valid Indian mobile range.
  const users = [
    { id: "sample-user-admin", phone: "+915555500001", name: "Sample Admin", roles: ["MEMBER", "ADMIN"] as const },
    { id: "sample-user-mechanic", phone: "+915555500002", name: "Sample Mechanic", roles: ["MEMBER", "MECHANIC"] as const },
    { id: "sample-user-seller", phone: "+915555500003", name: "Sample Seller", roles: ["MEMBER"] as const },
    { id: "sample-user-seller-nopayout", phone: "+915555500004", name: "Sample Seller Without Payouts", roles: ["MEMBER"] as const },
    { id: "sample-user-buyer", phone: "+915555500005", name: "Sample Buyer", roles: ["MEMBER"] as const },
    { id: "sample-user-buyer-2", phone: "+915555500006", name: "Sample Buyer Two", roles: ["MEMBER"] as const },
  ];
  for (const u of users) {
    const data = { phone: u.phone, name: u.name, roles: [...u.roles], phoneVerifiedAt: ago(90 * DAY), isSample: true };
    await db.user.upsert({ where: { id: u.id }, create: { id: u.id, ...data }, update: data });
    await db.consentRecord.upsert({
      where: { id: `${u.id}-consent` },
      create: { id: `${u.id}-consent`, userId: u.id, purpose: "ACCOUNT_AND_ORDERS", version: SAMPLE_CONSENT_VERSION, grantedAt: ago(90 * DAY) },
      update: { version: SAMPLE_CONSENT_VERSION, withdrawnAt: null },
    });
  }

  const address = (id: string, userId: string, pincode: string, contactName: string) => ({
    id,
    userId,
    label: "Sample address",
    contactName,
    contactPhone: "+915555500000",
    line1: "Sample building, Sample street",
    city: "Sample City",
    state: "Sample State",
    pincode,
    isDefault: true,
    isSample: true,
  });
  const addresses = [
    address("sample-addr-seller", "sample-user-seller", "999901", "Sample Seller"),
    address("sample-addr-seller-nopayout", "sample-user-seller-nopayout", "999903", "Sample Seller Without Payouts"),
    address("sample-addr-buyer", "sample-user-buyer", "999902", "Sample Buyer"),
    address("sample-addr-buyer-2", "sample-user-buyer-2", "999905", "Sample Buyer Two"),
  ];
  for (const a of addresses) await db.address.upsert({ where: { id: a.id }, create: a, update: a });

  // Payout accounts (provider reference + status only; never bank details)
  const payouts = [
    { id: "sample-payout-seller", userId: "sample-user-seller", provider: "mock", providerVendorId: "sample-mock-vendor-seller", status: "ACTIVE" as const },
    { id: "sample-payout-seller-nopayout", userId: "sample-user-seller-nopayout", provider: "mock", providerVendorId: null, status: "NOT_STARTED" as const },
  ];
  for (const p of payouts) await db.payoutAccount.upsert({ where: { id: p.id }, create: p, update: p });

  // Garage: buyer has a primary Roadster 200 ABS
  await db.garageVehicle.upsert({
    where: { id: "sample-garage-buyer-roadster" },
    create: { id: "sample-garage-buyer-roadster", userId: "sample-user-buyer", variantId: "sample-variant-roadster-200-abs", year: 2022, nickname: "Sample Roadster", isPrimary: true },
    update: { isPrimary: true },
  });
  await db.garageVehicle.upsert({
    where: { id: "sample-garage-buyer-city" },
    create: { id: "sample-garage-buyer-city", userId: "sample-user-buyer", variantId: "sample-variant-city-125-conn", year: 2023, isPrimary: false },
    update: {},
  });

  // Mechanic partner
  await db.mechanicPartner.upsert({
    where: { id: "sample-garage-partner" },
    create: {
      id: "sample-garage-partner",
      garageName: "Sample Garage (sample)",
      addressLine: "Sample workshop lane",
      city: "Sample City",
      state: "Sample State",
      pincode: "999901",
      servicePincodes: ["999901", "999902", "999903"],
      capacityPerDay: 4,
      feePerInspection: rupees(200),
      isSample: true,
    },
    update: {},
  });
  await db.mechanicStaff.upsert({
    where: { userId: "sample-user-mechanic" },
    create: { id: "sample-mechanic-staff", userId: "sample-user-mechanic", partnerId: "sample-garage-partner" },
    update: {},
  });

  // ── Listings in every status ──
  type ListingSeed = {
    id: string;
    status: ListingStatus;
    categorySlug: string;
    partNumberId?: string;
    title: string;
    priceRupees?: number;
    grade?: ConditionGrade;
    requirement?: InspectionRequirement;
    reason?: InspectionReason;
    trust?: TrustLabel;
    risk?: number;
    wizardStep?: number;
    sellerId?: string;
    fulfilmentMode?: FulfilmentMode;
    weightBand?: WeightBand;
    sellerVariantId: string;
    sellerMessage?: string;
  };

  const listings: ListingSeed[] = [
    { id: "sample-listing-draft", status: "DRAFT", categorySlug: "brake-pads", title: "SAMPLE front brake pads (draft)", wizardStep: 3, sellerVariantId: "sample-variant-street-150-std" },
    { id: "sample-listing-submitted", status: "SUBMITTED", categorySlug: "mirrors", partNumberId: "sample-pn-mir-0002", title: "SAMPLE left mirror", priceRupees: 450, grade: "GOOD", sellerVariantId: "sample-variant-roadster-200-std" },
    { id: "sample-listing-screening", status: "SCREENING", categorySlug: "seats", title: "SAMPLE rider seat", priceRupees: 1800, grade: "FAIR", sellerVariantId: "sample-variant-city-125-std" },
    {
      id: "sample-listing-changes",
      status: "CHANGES_REQUESTED",
      categorySlug: "lights",
      partNumberId: "sample-pn-lgt-0001",
      title: "SAMPLE headlight unit",
      priceRupees: 2200,
      grade: "GOOD",
      risk: 10,
      sellerVariantId: "sample-variant-city-125-std",
      sellerMessage: "Photo 2 is blurry. Retake it in daylight, holding the phone steady.",
    },
    { id: "sample-listing-rejected", status: "REJECTED", categorySlug: "accessories", title: "SAMPLE accessory (rejected by admin)", priceRupees: 300, grade: "FAIR", risk: 70, sellerVariantId: "sample-variant-street-150-std", sellerMessage: "SAMPLE: rejected by admin review." },
    { id: "sample-listing-live-tier-a", status: "LIVE", categorySlug: "mirrors", partNumberId: "sample-pn-mir-0001", title: "SAMPLE right mirror", priceRupees: 650, grade: "LIKE_NEW", requirement: "NOT_NEEDED", trust: "SCREENED", risk: 5, sellerVariantId: "sample-variant-roadster-200-abs" },
    { id: "sample-listing-live-tier-b-required", status: "LIVE", categorySlug: "exhausts", partNumberId: "sample-pn-exh-0001", title: "SAMPLE full exhaust", priceRupees: 8500, grade: "GOOD", requirement: "REQUIRED", reason: "TIER_B_THRESHOLD", trust: "SCREENED", risk: 12, weightBand: "KG_3_7", sellerVariantId: "sample-variant-street-150-std" },
    { id: "sample-listing-live-tier-b-optional", status: "LIVE", categorySlug: "lights", partNumberId: "sample-pn-lgt-0002", title: "SAMPLE tail light", priceRupees: 900, grade: "GOOD", requirement: "OPTIONAL", trust: "SCREENED", risk: 8, sellerVariantId: "sample-variant-city-125-std" },
    { id: "sample-listing-live-tier-c", status: "LIVE", categorySlug: "brake-pads", partNumberId: "sample-pn-brk-0003", title: "SAMPLE rear brake pads", priceRupees: 700, grade: "GOOD", requirement: "REQUIRED", reason: "TIER_C", trust: "SELLER_DECLARED", risk: 30, sellerVariantId: "sample-variant-roadster-200-std" },
    {
      id: "sample-listing-live-pickup-nopayout",
      status: "LIVE",
      categorySlug: "body-panels-and-fairings",
      title: "SAMPLE side panel (local pickup, seller has no payout account)",
      priceRupees: 1200,
      grade: "FAIR",
      requirement: "NOT_NEEDED",
      trust: "SCREENED",
      risk: 10,
      sellerId: "sample-user-seller-nopayout",
      fulfilmentMode: "LOCAL_PICKUP",
      sellerVariantId: "sample-variant-demo-scoot-110-std",
    },
    { id: "sample-listing-reserved", status: "RESERVED", categorySlug: "grips", title: "SAMPLE handlebar grips", priceRupees: 350, grade: "LIKE_NEW", requirement: "NOT_NEEDED", trust: "SCREENED", risk: 3, sellerVariantId: "sample-variant-street-150-disc" },
    { id: "sample-listing-reserved-disputed", status: "RESERVED", categorySlug: "seats", partNumberId: "sample-pn-set-0001", title: "SAMPLE pillion seat", priceRupees: 2400, grade: "GOOD", requirement: "OPTIONAL", trust: "SCREENED", risk: 15, sellerVariantId: "sample-variant-city-125-conn" },
    { id: "sample-listing-sold", status: "SOLD", categorySlug: "wheels", partNumberId: "sample-pn-whl-0001", title: "SAMPLE front wheel", priceRupees: 5200, grade: "GOOD", requirement: "REQUIRED", reason: "TIER_C", trust: "PARTNER_CHECK", risk: 10, weightBand: "KG_3_7", sellerVariantId: "sample-variant-roadster-200-abs" },
    { id: "sample-listing-withdrawn", status: "WITHDRAWN", categorySlug: "mirrors", title: "SAMPLE mirror pair (withdrawn)", priceRupees: 800, grade: "GOOD", sellerVariantId: "sample-variant-street-150-std" },
  ];

  for (const l of listings) {
    const sellerId = l.sellerId ?? "sample-user-seller";
    const pickupAddressId = sellerId === "sample-user-seller" ? "sample-addr-seller" : "sample-addr-seller-nopayout";
    const pickupPincode = sellerId === "sample-user-seller" ? "999901" : "999903";
    const pn = SAMPLE_PART_NUMBERS.find((p) => p.id === l.partNumberId);
    const screened = !["DRAFT", "SUBMITTED", "SCREENING"].includes(l.status);
    const data = {
      sellerId,
      categoryId: catId(l.categorySlug),
      partNumberId: l.partNumberId ?? null,
      partNumberEntered: pn?.display ?? null,
      partName: l.title.replace(/^SAMPLE /, ""),
      title: l.title,
      description: l.status === "DRAFT" ? null : "SAMPLE listing for development. Not a real item.",
      conditionGrade: l.grade ?? null,
      conditionScore: l.grade ? { LIKE_NEW: 95, GOOD: 80, FAIR: 55, FOR_REPAIR: 30 }[l.grade] : null,
      kmUsedApprox: l.status === "DRAFT" ? null : 8000,
      reasonForSale: l.status === "DRAFT" ? null : "SAMPLE: upgraded to a different part.",
      pricePaise: l.priceRupees ? rupees(l.priceRupees) : null,
      pickupAddressId,
      pickupPincode,
      weightBand: l.status === "DRAFT" ? null : (l.weightBand ?? "UNDER_1KG"),
      dimensionBand: l.status === "DRAFT" ? null : ("SMALL" as const),
      fulfilmentMode: l.fulfilmentMode ?? "DELIVERY",
      status: l.status,
      wizardStep: l.wizardStep ?? 7,
      inspectionRequirement: l.requirement ?? null,
      inspectionReason: l.reason ?? null,
      trustLabel: l.trust ?? "SELLER_DECLARED",
      latestRiskScore: screened ? (l.risk ?? null) : null,
      sellerMessage: l.sellerMessage ?? null,
      isSample: true,
      submittedAt: l.status === "DRAFT" ? null : ago(20 * DAY),
      liveAt: ["LIVE", "RESERVED", "SOLD", "WITHDRAWN"].includes(l.status) ? ago(19 * DAY) : null,
      soldAt: l.status === "SOLD" ? ago(10 * DAY) : null,
    };
    await db.listing.upsert({ where: { id: l.id }, create: { id: l.id, ...data }, update: data });

    // Seller-declared fitment for the seller's own bike
    const fid = `${l.id}-fit-seller`;
    const fdata = { listingId: l.id, variantId: l.sellerVariantId, source: "SELLER_DECLARED" as const, isSample: true };
    await db.fitment.upsert({ where: { id: fid }, create: { id: fid, ...fdata }, update: fdata });

    if (screened && l.risk !== undefined) {
      const hard = l.status === "CHANGES_REQUESTED";
      const rid = `${l.id}-risk-1`;
      const rdata = {
        listingId: l.id,
        score: l.risk,
        reasons: json(
          hard
            ? [{ code: "BLUR", message: "Photo 2 is blurry. Retake it in daylight, holding the phone steady.", severity: "HARD", step: "photos" }]
            : l.status === "REJECTED"
              ? [{ code: "ADMIN_REJECTED", message: "SAMPLE: rejected by admin review.", severity: "INFO" }]
              : [],
        ),
        checkResults: json({ SAMPLE: { passed: !hard, note: "Seeded result, not produced by the pipeline." } }),
        hadHardFailure: hard,
        ruleSetVersion: 1,
        visionModelVersion: hard ? null : "mock-vision-0",
        // The rejected sample went LIVE first and was then rejected by an admin (L7).
        routingDecision: hard ? ("CHANGES_REQUESTED" as const) : ("LIVE" as const),
        inspectionRequirement: l.requirement ?? null,
        inspectionReason: l.reason ?? null,
        trustLabel: l.trust ?? null,
        createdAt: ago(19 * DAY),
      };
      await db.riskAssessment.upsert({ where: { id: rid }, create: { id: rid, ...rdata }, update: rdata });
    }
  }

  // ── Orders (platform fee snapshot from settings v1: 0 bps) ──
  const bps = settings.fees.platformFeeBps;
  const sellerPickup = json({ city: "Sample City", pincode: "999901", note: "SAMPLE" });
  const buyerDelivery = json({ city: "Sample City", pincode: "999902", note: "SAMPLE" });

  type OrderSeed = {
    id: string;
    listingId: string;
    state: OrderState;
    item: number;
    shipping: number;
    check: number;
    paidDaysAgo: number | null;
    path: OrderState[];
    extra?: Partial<Prisma.OrderUncheckedCreateInput>;
  };
  const orders: OrderSeed[] = [
    {
      id: "sample-order-awaiting-seller",
      listingId: "sample-listing-reserved",
      state: "AWAITING_SELLER",
      item: rupees(350),
      shipping: rupees(80),
      check: 0,
      paidDaysAgo: 0.2,
      path: ["CREATED", "PAID_HELD", "AWAITING_SELLER"],
      extra: { sellerConfirmBy: ahead(20 * HOUR) },
    },
    {
      id: "sample-order-disputed",
      listingId: "sample-listing-reserved-disputed",
      state: "DISPUTED",
      item: rupees(2400),
      shipping: rupees(150),
      check: 0,
      paidDaysAgo: 40, // auto-release in 5 days → appears in the 7-day admin warning panel
      path: ["CREATED", "PAID_HELD", "AWAITING_SELLER", "PICKUP_SCHEDULED", "IN_TRANSIT", "DELIVERED", "ACCEPTANCE_WINDOW", "DISPUTED"],
      extra: { acceptanceEndsAt: ago(1 * DAY) },
    },
    {
      id: "sample-order-completed",
      listingId: "sample-listing-sold",
      state: "COMPLETED",
      item: rupees(5200),
      shipping: rupees(250),
      check: rupees(299),
      paidDaysAgo: 14,
      path: ["CREATED", "PAID_HELD", "AWAITING_SELLER", "INSPECTION_SCHEDULED", "INSPECTION_PASSED", "PICKUP_SCHEDULED", "IN_TRANSIT", "DELIVERED", "ACCEPTANCE_WINDOW", "COMPLETED"],
      extra: { inspectionReason: "TIER_C", completedAt: ago(10 * DAY), buyerVehicleId: "sample-garage-buyer-roadster" },
    },
    {
      id: "sample-order-cancelled-seller-timeout",
      listingId: "sample-listing-live-tier-a",
      state: "CANCELLED",
      item: rupees(650),
      shipping: rupees(80),
      check: 0,
      paidDaysAgo: 5,
      path: ["CREATED", "PAID_HELD", "AWAITING_SELLER", "CANCELLED"],
      extra: { cancelReason: "SAMPLE: seller did not confirm within 24 hours." },
    },
  ];

  for (const o of orders) {
    const money = orderMoney(o.item, o.shipping, o.check, bps);
    const paidAt = o.paidDaysAgo === null ? null : ago(o.paidDaysAgo * DAY);
    const data = {
      buyerId: "sample-user-buyer",
      sellerId: "sample-user-seller",
      listingId: o.listingId,
      fulfilmentMode: "DELIVERY" as const,
      ...money,
      state: o.state,
      deliveryAddress: buyerDelivery,
      pickupAddress: sellerPickup,
      autoReleaseAt: paidAt ? new Date(paidAt.getTime() + settings.orders.providerMaxHoldDays * DAY) : null,
      settingsVersion: 1,
      idempotencyKey: `${o.id}-key`,
      isSample: true,
      createdAt: paidAt ?? now,
      ...o.extra,
    };
    await db.order.upsert({ where: { id: o.id }, create: { id: o.id, ...data }, update: data });

    const settlement =
      o.state === "COMPLETED" ? "ELIGIBLE" : o.state === "CANCELLED" ? "REVERSED" : "HELD";
    const pdata = {
      orderId: o.id,
      provider: "mock",
      providerOrderId: `sample-mock-order-${o.id}`,
      providerPaymentId: `sample-mock-payment-${o.id}`,
      status: "SUCCESS" as const,
      amountPaise: money.totalPaise,
      vendorId: "sample-mock-vendor-seller",
      vendorSharePaise: money.vendorSharePaise,
      merchantSharePaise: money.merchantSharePaise,
      vendorSettlementStatus: settlement as "ELIGIBLE" | "REVERSED" | "HELD",
      settlementEligibleAt: o.state === "COMPLETED" ? ago(10 * DAY) : null,
      paidAt,
    };
    const paymentId = `${o.id}-payment`;
    await db.payment.upsert({ where: { id: paymentId }, create: { id: paymentId, ...pdata }, update: pdata });

    await db.orderEvent.createMany({
      data: o.path.map((to, i) => ({
        id: `${o.id}-event-${i}`,
        orderId: o.id,
        fromState: i === 0 ? null : o.path[i - 1]!,
        toState: to,
        event: i === 0 ? "create" : `seed:${to.toLowerCase()}`,
        actorType: "SYSTEM" as const,
        payload: json({ sample: true }),
        createdAt: new Date((paidAt ?? now).getTime() + i * HOUR),
      })),
      skipDuplicates: true,
    });

    if (o.state === "CANCELLED") {
      // Full refund, pre-settlement, one-fee allocation (PLAN.md §7.5).
      const feeShare = money.platformFeePaise; // full item refunded → full fee returned
      const refundId = `${o.id}-refund`;
      const rdata = {
        paymentId,
        amountPaise: money.totalPaise,
        vendorPortionPaise: money.itemPricePaise - feeShare,
        merchantPortionPaise: feeShare + money.shippingFeePaise + money.checkFeePaise,
        components: json({ item: money.itemPricePaise, shipping: money.shippingFeePaise, check: money.checkFeePaise }),
        reason: "SAMPLE: seller timeout, full refund",
        withSplitReversal: true,
        status: "SUCCESS" as const,
        idempotencyKey: `${refundId}-key`,
      };
      await db.refund.upsert({ where: { id: refundId }, create: { id: refundId, ...rdata }, update: rdata });
    }
  }

  // Inspection (PASS) behind the sold listing's Partner Check label
  await db.inspection.upsert({
    where: { id: "sample-inspection-sold" },
    create: {
      id: "sample-inspection-sold",
      listingId: "sample-listing-sold",
      orderId: "sample-order-completed",
      partnerId: "sample-garage-partner",
      mechanicUserId: "sample-user-mechanic",
      reason: "TIER_C",
      status: "COMPLETED",
      slotStart: ago(13 * DAY),
      slotEnd: ago(13 * DAY - 2 * HOUR),
      checklistResults: json({ "wheel-bent": "NO", "wheel-cracked": "NO", "wheel-bearings-ok": "YES" }),
      measuredValues: json([{ key: "runout", label: "Rim runout", value: 0.4, unit: "mm" }]),
      outcome: "PASS",
      notes: "SAMPLE inspection. Visual and basic check.",
      buyerFeePaise: rupees(299),
      completedAt: ago(13 * DAY),
    },
    update: {},
  });

  // Dispute on the disputed order
  await db.dispute.upsert({
    where: { orderId: "sample-order-disputed" },
    create: {
      id: "sample-dispute-1",
      orderId: "sample-order-disputed",
      reason: "NOT_AS_DESCRIBED",
      description: "SAMPLE: the seat cover has a tear that was not in the photos.",
      status: "UNDER_REVIEW",
      sellerResponse: "SAMPLE: the tear happened in transit.",
      sellerRespondedAt: ago(0.5 * DAY),
    },
    update: {},
  });

  // Review after completion
  await db.review.upsert({
    where: { orderId_direction: { orderId: "sample-order-completed", direction: "BUYER_TO_SELLER" } },
    create: {
      id: "sample-review-1",
      orderId: "sample-order-completed",
      authorId: "sample-user-buyer",
      subjectId: "sample-user-seller",
      direction: "BUYER_TO_SELLER",
      rating: 4,
      text: "SAMPLE review.",
    },
    update: {},
  });
}

// ───────────────────────────── CLI ─────────────────────────────

async function main() {
  const { target, url } = resolveSeedTarget(process.argv.slice(2), process.env);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    await seed(db);
    console.log(`Seeded SAMPLE data into the ${target === "test" ? "local test" : "Supabase development"} database.`);
  } finally {
    await db.$disconnect();
  }
}

const invokedDirectly = process.argv[1] && /seed\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
