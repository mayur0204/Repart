import "server-only";
import { z } from "zod";
import { Prisma, type ListingStatus, type PrismaClient } from "@/generated/prisma/client";
import { gradeFromChecklist, stepNumber, type ChecklistAnswers, type ChecklistItem, type StepSlug } from "@/lib/listing";
import { normalizePartNumber } from "@/lib/part-number";
import { FieldError, NotFoundError, UserError } from "../../http/errors";
import { consumeRateLimit } from "../../http/rate-limit";
import { loadInterchange } from "../interchange/interchange";
import { isMaterialPriceChange, onMaterialEdit } from "../inspection/label";
import { getActiveSettings } from "../settings/settings";
import { transitionListing } from "./state";
import { checkSteps, MAX_DESCRIPTION, MIN_DESCRIPTION, type StepReport } from "./steps";

/**
 * Listing drafts and the 7-step wizard (REPART_BRIEF.md §9, PLAN.md §4.4). Every function checks
 * that the listing belongs to the caller. Only DRAFT and CHANGES_REQUESTED listings can be edited;
 * editing a LIVE listing (material-edit rule L9) arrives with the risk pipeline in M5.
 */
type Db = PrismaClient;
type Actor = { userId: string; requestId?: string };

export type { ListingStatus };

export const EDITABLE: ListingStatus[] = ["DRAFT", "CHANGES_REQUESTED"];
export const MAX_OPEN_DRAFTS = 20;

/** The caller's listing, or NotFound (never reveals other sellers' listings). */
export async function getOwnedListing(db: Pick<Db, "listing">, userId: string, id: string) {
  const listing = await db.listing.findFirst({ where: { id, sellerId: userId } });
  if (!listing) throw new NotFoundError("listing");
  return listing;
}

async function getEditable(db: Pick<Db, "listing">, userId: string, id: string) {
  const listing = await getOwnedListing(db, userId, id);
  if (!EDITABLE.includes(listing.status)) throw new UserError("This listing can't be edited in its current state.");
  return listing;
}

const advance = (current: number, step: StepSlug) => Math.max(current, Math.min(7, stepNumber(step) + 1));

export async function createDraft(db: Db, actor: Actor) {
  const open = await db.listing.count({ where: { sellerId: actor.userId, status: "DRAFT" } });
  if (open >= MAX_OPEN_DRAFTS) throw new UserError(`You have ${open} drafts. Finish or withdraw one before starting another.`);
  return db.listing.create({ data: { sellerId: actor.userId, status: "DRAFT", wizardStep: 1 } });
}

// ── Step 1: bike ──
export const bikeInput = z.union([
  z.object({ garageVehicleId: z.string().min(1) }),
  z.object({ variantId: z.string().min(1, "Choose the variant.") }),
]);

/** The seller's own bike is stored as a SELLER_DECLARED fitment on the listing. */
export async function saveBike(db: Db, actor: Actor, listingId: string, input: unknown) {
  const listing = await getEditable(db, actor.userId, listingId);
  const data = bikeInput.parse(input);
  let variantId: string;
  if ("garageVehicleId" in data) {
    const vehicle = await db.garageVehicle.findFirst({ where: { id: data.garageVehicleId, userId: actor.userId } });
    if (!vehicle) throw new FieldError({ garageVehicleId: "Choose one of your bikes." });
    variantId = vehicle.variantId;
  } else {
    if (!(await db.vehicleVariant.findUnique({ where: { id: data.variantId } }))) throw new FieldError({ variantId: "Choose the variant from the list." });
    variantId = data.variantId;
  }
  await db.$transaction(async (tx) => {
    await tx.fitment.deleteMany({ where: { listingId, source: "SELLER_DECLARED" } });
    await tx.fitment.create({ data: { listingId, variantId, source: "SELLER_DECLARED", createdById: actor.userId } });
    await tx.listing.update({ where: { id: listingId }, data: { wizardStep: advance(listing.wizardStep, "bike") } });
  });
}

// ── Step 2: part ──
export async function findCataloguePartNumbers(db: Pick<Db, "partNumber">, number: string) {
  const normalized = normalizePartNumber(number);
  if (normalized.length < 2) return [];
  return db.partNumber.findMany({
    where: { normalized },
    select: { id: true, display: true, brand: true, isOem: true, isSample: true, category: { select: { id: true, name: true, partNumberHint: true, isSafetyCritical: true } } },
    orderBy: { brand: "asc" },
  });
}

/** Vehicles the part number (and its interchange group) is recorded to fit, for the seller to confirm. */
export async function suggestedVariants(db: Db, partNumberId: string) {
  const { group } = await loadInterchange(db, partNumberId);
  const fitments = await db.fitment.findMany({
    where: { partNumberId: { in: group.map((m) => m.partNumberId) }, listingId: null, verdict: "FITS" },
    select: { variant: { select: { id: true, name: true, yearFrom: true, yearTo: true, model: { select: { name: true, make: { select: { name: true } } } } } } },
  });
  return [...new Map(fitments.map((f) => [f.variant.id, f.variant])).values()];
}

export const partInput = z.object({
  partNumberId: z.string().min(1, "Choose the part number from our catalogue."),
  partName: z.string().trim().min(3, "Enter the part name, for example 'Front brake pads'.").max(80, "Keep the part name under 80 characters."),
  confirmedVariantIds: z.array(z.string()).default([]),
});

export async function savePart(db: Db, actor: Actor, listingId: string, input: unknown) {
  const listing = await getEditable(db, actor.userId, listingId);
  const data = partInput.parse(input);
  const part = await db.partNumber.findUnique({ where: { id: data.partNumberId } });
  if (!part) throw new FieldError({ partNumberId: "Choose the part number from our catalogue." });
  const suggested = new Set((await suggestedVariants(db, part.id)).map((v) => v.id));
  const confirmed = [...new Set(data.confirmedVariantIds)].filter((id) => suggested.has(id));
  const categoryChanged = listing.categoryId !== null && listing.categoryId !== part.categoryId;

  await db.$transaction(async (tx) => {
    await tx.fitment.deleteMany({ where: { listingId, source: "PART_NUMBER_MATCH" } });
    if (confirmed.length) {
      await tx.fitment.createMany({ data: confirmed.map((variantId) => ({ listingId, variantId, source: "PART_NUMBER_MATCH" as const, createdById: actor.userId })) });
    }
    await tx.listing.update({
      where: { id: listingId },
      data: {
        partNumberId: part.id,
        partNumberEntered: part.display,
        categoryId: part.categoryId,
        partName: data.partName,
        title: data.partName,
        // A different category has a different checklist; the old answers no longer apply.
        ...(categoryChanged ? { checklistAnswers: Prisma.DbNull, conditionScore: null, conditionGrade: null } : {}),
        wizardStep: advance(listing.wizardStep, "part"),
      },
    });
  });
  // PLAN §5.1 L9: a new category or part number is a material edit (ends any Partner Check label, M10).
  if (categoryChanged) await onMaterialEdit(db, listingId, "category", actor.userId);
  else if (listing.partNumberId !== null && listing.partNumberId !== part.id) await onMaterialEdit(db, listingId, "part_number", actor.userId);
}

// ── Step 3: condition ──
export async function saveCondition(db: Db, actor: Actor, listingId: string, answers: Record<string, unknown>) {
  const listing = await getEditable(db, actor.userId, listingId);
  if (!listing.categoryId) throw new UserError("Choose the part first, so we can show the right checklist.");
  const category = await db.partCategory.findUniqueOrThrow({ where: { id: listing.categoryId } });
  const items = category.conditionChecklist as unknown as ChecklistItem[];
  const clean: ChecklistAnswers = {};
  const missing: Record<string, string> = {};
  for (const item of items) {
    const a = answers[item.id];
    if (a === "YES" || a === "NO") clean[item.id] = a;
    else missing[item.id] = "Answer yes or no.";
  }
  if (Object.keys(missing).length) throw new FieldError(missing);
  const { settings } = await getActiveSettings(db);
  const { score, grade } = gradeFromChecklist(items, clean, settings.grading);
  await db.listing.update({
    where: { id: listingId },
    data: { checklistAnswers: clean, conditionScore: score, conditionGrade: grade, wizardStep: advance(listing.wizardStep, "condition") },
  });
  // PLAN §5.1 L9: changed checklist answers are a material edit (M10 Partner Check label).
  const before = (listing.checklistAnswers ?? null) as ChecklistAnswers | null;
  if (before && items.some((i) => before[i.id] !== clean[i.id])) await onMaterialEdit(db, listingId, "checklist", actor.userId);
  return { score, grade };
}

// ── Step 5: details ──
export const detailsInput = z.object({
  kmUsedApprox: z
    .union([z.literal(""), z.coerce.number().int("Enter whole kilometres.").min(0).max(500_000, "Enter a realistic distance.")])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  reasonForSale: z.string().trim().max(200, "Keep the reason under 200 characters.").optional().transform((v) => (v ? v : null)),
  description: z
    .string()
    .trim()
    .min(MIN_DESCRIPTION, `Write at least ${MIN_DESCRIPTION} characters: what it is, how it was used, any faults.`)
    .max(MAX_DESCRIPTION, `Keep the description under ${MAX_DESCRIPTION} characters.`),
});

export async function saveDetails(db: Db, actor: Actor, listingId: string, input: unknown) {
  const listing = await getEditable(db, actor.userId, listingId);
  const data = detailsInput.parse(input);
  await db.listing.update({ where: { id: listingId }, data: { ...data, wizardStep: advance(listing.wizardStep, "details") } });
}

// ── Step 6: price and pickup ──
export const MIN_PRICE_PAISE = 50 * 100;
export const MAX_PRICE_PAISE = 5_00_000 * 100;

export const priceInput = z.object({
  priceRupees: z.coerce
    .number({ message: "Enter a price in rupees." })
    .min(MIN_PRICE_PAISE / 100, "The lowest price is ₹50.")
    .max(MAX_PRICE_PAISE / 100, "The highest price is ₹5,00,000.")
    .transform((r) => Math.round(r * 100)),
  pickupAddressId: z.string().min(1, "Choose a pickup address."),
  weightBand: z.enum(["UNDER_1KG", "KG_1_3", "KG_3_7", "KG_7_15", "KG_15_30", "OVER_30KG"], { message: "Choose the packed weight." }),
  dimensionBand: z.enum(["SMALL", "MEDIUM", "LARGE", "OVERSIZE"], { message: "Choose the packed size." }),
  fulfilmentMode: z.enum(["DELIVERY", "LOCAL_PICKUP"], { message: "Choose delivery or local pickup." }),
});

export async function savePrice(db: Db, actor: Actor, listingId: string, input: unknown) {
  const listing = await getEditable(db, actor.userId, listingId);
  const data = priceInput.parse(input);
  const address = await db.address.findFirst({ where: { id: data.pickupAddressId, userId: actor.userId } });
  if (!address) throw new FieldError({ pickupAddressId: "Choose one of your saved addresses." });
  if (listing.categoryId && data.fulfilmentMode === "DELIVERY") {
    const category = await db.partCategory.findUniqueOrThrow({ where: { id: listing.categoryId } });
    if (category.shippingRestriction === "NOT_SHIPPABLE") throw new FieldError({ fulfilmentMode: "Parts in this category can only be sold for local pickup." });
  }
  await db.listing.update({
    where: { id: listingId },
    data: {
      pricePaise: data.priceRupees,
      pickupAddressId: address.id,
      pickupPincode: address.pincode,
      weightBand: data.weightBand,
      dimensionBand: data.dimensionBand,
      fulfilmentMode: data.fulfilmentMode,
      wizardStep: advance(listing.wizardStep, "price"),
    },
  });
  // PLAN §5.1 L9: a price change above settings.risk.materialPriceChangePercent is material (M10 Partner Check label).
  const { settings } = await getActiveSettings(db);
  if (isMaterialPriceChange(listing.pricePaise, data.priceRupees, settings)) await onMaterialEdit(db, listingId, "price", actor.userId);
}

// ── wizard state, preview, submit ──

/** Everything the wizard needs about a listing, plus which steps are complete. */
export async function getWizardState(db: Db, userId: string, listingId: string) {
  const listing = await getOwnedListing(db, userId, listingId);
  const [category, part, fitments, photos, active] = await Promise.all([
    listing.categoryId ? db.partCategory.findUnique({ where: { id: listing.categoryId } }) : null,
    listing.partNumberId ? db.partNumber.findUnique({ where: { id: listing.partNumberId }, select: { id: true, display: true, brand: true, isSample: true } }) : null,
    db.fitment.findMany({
      where: { listingId },
      select: { source: true, variant: { select: { id: true, name: true, yearFrom: true, yearTo: true, model: { select: { name: true, make: { select: { name: true } } } } } } },
    }),
    db.listingPhoto.findMany({ where: { listingId }, orderBy: { sortOrder: "asc" } }),
    getActiveSettings(db),
  ]);
  const { settings, version: settingsVersion } = active;
  const checklist = (category?.conditionChecklist ?? []) as unknown as ChecklistItem[];
  const photoGuide = (category?.photoGuide ?? []) as unknown as Array<{ shotType: string; label: string; instructions: string; required: boolean }>;
  const photoStatus = photos.map((p) => ({ ...p, status: photoState(p) }));
  const steps = checkSteps({
    listing,
    hasSellerBike: fitments.some((f) => f.source === "SELLER_DECLARED"),
    checklist,
    requiredShots: photoGuide.filter((s) => s.required),
    photos: photoStatus,
    settings: { minPhotos: settings.risk.minPhotos, grading: settings.grading },
  });
  return { listing, category, part, fitments, photos: photoStatus, checklist, photoGuide, steps, settings, settingsVersion, editable: EDITABLE.includes(listing.status) };
}

export function photoState(p: { processedAt: Date | null; storageKey: string | null }): "processing" | "ready" | "failed" {
  if (!p.processedAt) return "processing";
  return p.storageKey ? "ready" : "failed";
}

/** Submit (L1) or resubmit (L2) after checking every step, the payout guard and the rate limit. */
export async function submitListing(db: Db, actor: Actor, listingId: string): Promise<StepReport | null> {
  const state = await getWizardState(db, actor.userId, listingId);
  const event = state.listing.status === "DRAFT" ? "submit" : state.listing.status === "CHANGES_REQUESTED" ? "resubmit" : null;
  if (!event) throw new UserError("This listing has already been submitted.");
  if (Object.values(state.steps).some((p) => p.length)) return state.steps;

  if (state.listing.fulfilmentMode === "DELIVERY") {
    const payout = await db.payoutAccount.findUnique({ where: { userId: actor.userId } });
    if (payout?.status !== "ACTIVE") {
      throw new UserError("To sell with delivery, your payout account must be active so we can pay you. Choose local pickup for now, or set up payouts first.");
    }
  }
  await consumeRateLimit(db, "listingSubmissionsPerUser", actor.userId);
  await db.$transaction((tx) =>
    transitionListing(tx, { listingId, event, actor: { type: "USER", id: actor.userId }, requestId: actor.requestId, payload: { settingsVersion: state.settingsVersion } }),
  );
  return null;
}

export async function withdrawListing(db: Db, actor: Actor, listingId: string) {
  await getOwnedListing(db, actor.userId, listingId);
  await db.$transaction((tx) => transitionListing(tx, { listingId, event: "withdraw", actor: { type: "USER", id: actor.userId }, requestId: actor.requestId }));
}

/**
 * Typical price of comparable listings (same part-number group), shown only with enough data
 * (settings.risk.minComparables). Returns the middle half (25th–75th percentile), rounded to ₹10.
 */
export async function comparablePriceRange(db: Db, listing: { id: string; partNumberId: string | null }) {
  if (!listing.partNumberId) return null;
  const { settings } = await getActiveSettings(db);
  const { group } = await loadInterchange(db, listing.partNumberId);
  const prices = (
    await db.listing.findMany({
      where: { id: { not: listing.id }, partNumberId: { in: group.map((m) => m.partNumberId) }, status: { in: ["LIVE", "RESERVED", "SOLD"] }, pricePaise: { not: null } },
      select: { pricePaise: true },
    })
  )
    .map((l) => l.pricePaise!)
    .sort((a, b) => a - b);
  if (prices.length < settings.risk.minComparables) return null;
  const at = (q: number) => prices[Math.min(prices.length - 1, Math.floor(q * (prices.length - 1)))]!;
  const round10 = (p: number) => Math.round(p / 1000) * 1000;
  return { lowPaise: round10(at(0.25)), highPaise: round10(at(0.75)), count: prices.length };
}

/** Seller dashboard: the caller's listings grouped by status (PLAN.md §4.4 /seller). */
export async function listSellerListings(db: Pick<Db, "listing">, userId: string) {
  const rows = await db.listing.findMany({
    where: { sellerId: userId },
    select: { id: true, title: true, status: true, pricePaise: true, wizardStep: true, updatedAt: true, _count: { select: { photos: true } } },
    orderBy: { updatedAt: "desc" },
  });
  const groups = new Map<ListingStatus, typeof rows>();
  for (const r of rows) groups.set(r.status, [...(groups.get(r.status) ?? []), r]);
  return groups;
}
