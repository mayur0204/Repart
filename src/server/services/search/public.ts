import "server-only";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ChecklistAnswers, ChecklistItem } from "@/lib/listing";
import { distanceKm, isPincode } from "@/lib/geo";
import type { ShippingProvider } from "../../adapters/shipping/types";
import { NotFoundError, UserError } from "../../http/errors";
import { loadInterchange } from "../interchange/interchange";
import { enqueueOutbox } from "../outbox/outbox";
import { matchLabel } from "../interchange/graph";
import { fitsFor, searchListings, searchQuerySchema, type PublicDeps, type SearchQuery } from "./search";
import type { Vehicle } from "./fit";

/**
 * Public listing detail, seller profile, saved listings, saved searches and reports (M6).
 * Public objects are built field by field: no seller contact details, addresses, risk scores,
 * admin messages, audit data, payout data or storage keys ever leave this module.
 */
type Db = PrismaClient;

/** Statuses a buyer can open: live, plus reserved/sold shown as unavailable. Everything else is a 404. */
export const PUBLIC_STATUSES = ["LIVE", "RESERVED", "SOLD"] as const;

/** Parcel sizes used for the delivery estimate, from the seller's packed weight and size bands [assumption]. */
export const WEIGHT_GRAMS = { UNDER_1KG: 900, KG_1_3: 3000, KG_3_7: 7000, KG_7_15: 15000, KG_15_30: 30000, OVER_30KG: 40000 } as const;
export const SIZE_CM = { SMALL: [30, 20, 15], MEDIUM: [45, 35, 25], LARGE: [70, 50, 40], OVERSIZE: [120, 70, 50] } as const;

const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] ?? "RePart seller";

async function sellerSummary(db: Db, sellerId: string) {
  const [user, completedSales, rating] = await Promise.all([
    db.user.findUnique({ where: { id: sellerId }, select: { id: true, name: true, createdAt: true, isSample: true, status: true } }),
    db.listing.count({ where: { sellerId, status: "SOLD" } }),
    db.review.aggregate({ where: { subjectId: sellerId, direction: "BUYER_TO_SELLER" }, _avg: { rating: true }, _count: true }),
  ]);
  if (!user || user.status !== "ACTIVE") return null;
  return {
    id: user.id,
    displayName: firstName(user.name),
    memberSince: user.createdAt,
    completedSales,
    rating: rating._count ? { average: Math.round((rating._avg.rating ?? 0) * 10) / 10, count: rating._count } : null,
    isSample: user.isSample,
  };
}

export async function getPublicListing(db: Db, deps: PublicDeps & { shipping: ShippingProvider }, id: string, ctx: { vehicle: Vehicle | null; pincode: string | null }) {
  const l = await db.listing.findFirst({
    where: { id, status: { in: [...PUBLIC_STATUSES] } },
    select: {
      id: true,
      status: true,
      title: true,
      partName: true,
      description: true,
      kmUsedApprox: true,
      reasonForSale: true,
      pricePaise: true,
      conditionGrade: true,
      checklistAnswers: true,
      fulfilmentMode: true,
      trustLabel: true,
      inspectionRequirement: true,
      pickupPincode: true,
      weightBand: true,
      dimensionBand: true,
      isSample: true,
      liveAt: true,
      sellerId: true,
      partNumberId: true,
      category: { select: { name: true, slug: true, conditionChecklist: true, photoGuide: true, optionalCheckFee: true, isSafetyCritical: true } },
      partNumber: { select: { id: true, display: true, brand: true, isSample: true } },
      fitments: { select: { variantId: true, source: true, verdict: true, variant: { select: { id: true, name: true, yearFrom: true, yearTo: true, isSample: true, model: { select: { name: true, make: { select: { name: true } } } } } } } },
      photos: { where: { storageKey: { not: null } }, orderBy: { sortOrder: "asc" }, select: { storageKey: true, shotType: true } },
    },
  });
  if (!l) return null;

  const guide = (l.category?.photoGuide ?? []) as Array<{ shotType: string; label: string }>;
  const photos = await Promise.all(
    l.photos.map(async (p, i) => ({
      url: await deps.storage.createSignedDownloadUrl(deps.bucket, p.storageKey!, 600),
      caption: guide.find((g) => g.shotType === p.shotType)?.label ?? `Photo ${i + 1}`,
    })),
  );

  const checklist = ((l.category?.conditionChecklist ?? []) as unknown as ChecklistItem[]).map((q) => ({
    question: q.question,
    answer: ((l.checklistAnswers ?? {}) as ChecklistAnswers)[q.id] ?? null,
  }));

  // Compatibility: catalogue (part-number group), seller-declared, modification and not-fit, kept apart.
  const ix = l.partNumberId ? await loadInterchange(db, l.partNumberId) : null;
  const groupIds = ix?.group.map((m) => m.partNumberId) ?? [];
  const modIds = ix?.modifications.map((m) => m.partNumberId) ?? [];
  const [pnFitments, equivalentParts] = await Promise.all([
    db.fitment.findMany({
      where: { partNumberId: { in: [...groupIds, ...modIds] }, listingId: null },
      select: { partNumberId: true, verdict: true, source: true, variant: { select: { id: true, name: true, yearFrom: true, yearTo: true, isSample: true, model: { select: { name: true, make: { select: { name: true } } } } } } },
    }),
    db.partNumber.findMany({ where: { id: { in: [...groupIds, ...modIds].filter((x) => x !== l.partNumberId) } }, select: { id: true, display: true, brand: true, isSample: true } }),
  ]);
  type V = (typeof pnFitments)[number]["variant"];
  const name = (v: V) => `${v.model.make.name} ${v.model.name} ${v.name} (${v.yearFrom} to ${v.yearTo ?? "now"})`;
  const uniq = (vs: Array<{ label: string; note?: string | null }>) => [...new Map(vs.map((v) => [v.label + (v.note ?? ""), v])).values()].sort((a, b) => a.label.localeCompare(b.label));
  const modNote = new Map(ix?.modifications.map((m) => [m.partNumberId, m.notes ?? ""]) ?? []);
  const compatibility = {
    catalogue: uniq([
      ...l.fitments.filter((f) => f.verdict === "FITS" && f.source !== "SELLER_DECLARED").map((f) => ({ label: name(f.variant) })),
      ...pnFitments.filter((f) => f.verdict === "FITS" && groupIds.includes(f.partNumberId!)).map((f) => ({ label: name(f.variant) })),
    ]),
    sellerDeclared: uniq(l.fitments.filter((f) => f.source === "SELLER_DECLARED" && f.verdict === "FITS").map((f) => ({ label: name(f.variant) }))),
    modification: uniq(pnFitments.filter((f) => f.verdict === "FITS" && modNote.has(f.partNumberId!)).map((f) => ({ label: name(f.variant), note: modNote.get(f.partNumberId!) }))),
    notFit: uniq([...l.fitments, ...pnFitments.filter((f) => groupIds.includes(f.partNumberId!))].filter((f) => f.verdict === "DOES_NOT_FIT").map((f) => ({ label: name(f.variant) }))),
  };
  const byId = new Map(equivalentParts.map((p) => [p.id, p]));
  const equivalents = [...(ix?.group ?? []).filter((m) => m.kind !== "SAME"), ...(ix?.modifications ?? [])].map((m) => ({ ...byId.get(m.partNumberId)!, label: matchLabel(m) }));

  const fit = (await fitsFor(db, [l], ctx.vehicle)).get(l.id)!;

  // Location and delivery estimate for the buyer's pincode (distance only for pincodes with coordinates, A-24).
  const pins = [l.pickupPincode, ctx.pincode].filter(isPincode);
  const geo = new Map((await db.pincodeGeo.findMany({ where: { pincode: { in: pins } } })).map((g) => [g.pincode, g]));
  const from = l.pickupPincode ? geo.get(l.pickupPincode) : undefined;
  const to = ctx.pincode ? geo.get(ctx.pincode) : undefined;
  let delivery: { amountPaise: number; etaDays: number } | null = null;
  if (l.fulfilmentMode === "DELIVERY" && isPincode(ctx.pincode) && l.pickupPincode && l.weightBand && l.dimensionBand) {
    const ok = await deps.shipping.checkServiceability(l.pickupPincode, ctx.pincode);
    if (ok.serviceable) {
      const [length, width, height] = SIZE_CM[l.dimensionBand];
      const q = await deps.shipping.quote(l.pickupPincode, ctx.pincode, { weightGrams: WEIGHT_GRAMS[l.weightBand], lengthCm: length, widthCm: width, heightCm: height });
      delivery = { amountPaise: q.amount, etaDays: q.etaDays };
    }
  }

  return {
    id: l.id,
    status: l.status,
    title: l.title ?? "Untitled part",
    description: l.description,
    kmUsedApprox: l.kmUsedApprox,
    reasonForSale: l.reasonForSale,
    pricePaise: l.pricePaise ?? 0,
    conditionGrade: l.conditionGrade,
    checklist,
    fulfilmentMode: l.fulfilmentMode,
    trustLabel: l.trustLabel,
    inspectionRequirement: l.inspectionRequirement,
    checkFeePaise: l.category?.optionalCheckFee ?? 0,
    category: l.category ? { name: l.category.name, slug: l.category.slug, isSafetyCritical: l.category.isSafetyCritical } : null,
    partNumber: l.partNumber ? { display: l.partNumber.display, brand: l.partNumber.brand, isSample: l.partNumber.isSample } : null,
    equivalents,
    compatibility,
    fit,
    photos,
    location: from?.district ?? (l.pickupPincode ? `Pincode ${l.pickupPincode}` : null),
    distanceKm: from && to ? Math.round(distanceKm(from, to)) : null,
    delivery,
    isSample: l.isSample,
    liveAt: l.liveAt,
    seller: await sellerSummary(db, l.sellerId),
  };
}
export type PublicListing = NonNullable<Awaited<ReturnType<typeof getPublicListing>>>;

export async function getSellerProfile(db: Db, deps: PublicDeps, sellerId: string) {
  const seller = await sellerSummary(db, sellerId);
  if (!seller) return null;
  const ids = (await db.listing.findMany({ where: { sellerId, status: "LIVE" }, select: { id: true } })).map((l) => l.id);
  const live = ids.length ? await searchListings(db, { sort: "newest" }, { deps, onlyListingIds: ids }) : null;
  return { seller, tiles: live?.tiles ?? [] };
}

// ── saved listings ──
export async function toggleSavedListing(db: Db, userId: string, listingId: string): Promise<boolean> {
  const listing = await db.listing.findFirst({ where: { id: listingId, status: { in: [...PUBLIC_STATUSES] } }, select: { id: true } });
  if (!listing) throw new NotFoundError("listing");
  const existing = await db.savedListing.findUnique({ where: { userId_listingId: { userId, listingId } } });
  if (existing) {
    await db.savedListing.delete({ where: { userId_listingId: { userId, listingId } } });
    return false;
  }
  await db.savedListing.create({ data: { userId, listingId } });
  return true;
}

export async function isSaved(db: Db, userId: string, listingId: string) {
  return !!(await db.savedListing.findUnique({ where: { userId_listingId: { userId, listingId } } }));
}

/** Saved listings that are still public, newest first. */
export async function listSavedListings(db: Db, deps: PublicDeps, userId: string, vehicle: Vehicle | null) {
  const ids = (await db.savedListing.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, select: { listingId: true } })).map((s) => s.listingId);
  if (!ids.length) return [];
  const r = await searchListings(db, { sort: "newest" }, { deps, vehicle, onlyListingIds: ids });
  return ids.map((id) => r.tiles.find((t) => t.id === id)).filter((t) => !!t);
}

// ── reports ──
export const REPORT_REASONS = {
  WRONG_PART: "It isn't the part described",
  FAKE_OR_STOLEN: "It looks counterfeit or stolen",
  CONTACT_OR_SCAM: "The seller asked to deal outside RePart",
  PROHIBITED: "It isn't allowed on RePart",
  OTHER: "Something else",
} as const;

export const reportInput = z.object({
  listingId: z.string().min(1),
  reason: z.enum(Object.keys(REPORT_REASONS) as [keyof typeof REPORT_REASONS, ...Array<keyof typeof REPORT_REASONS>], { message: "Choose a reason." }),
  details: z.string().trim().max(1000).optional().transform((v) => (v ? v : null)),
});

/** One open report per member per listing; admin handling arrives in M12. */
export async function reportListing(db: Db, reporterId: string, input: unknown) {
  const data = reportInput.parse(input);
  const listing = await db.listing.findFirst({ where: { id: data.listingId, status: { in: [...PUBLIC_STATUSES] } }, select: { sellerId: true } });
  if (!listing) throw new NotFoundError("listing");
  if (listing.sellerId === reporterId) throw new UserError("You can't report your own listing. Withdraw it from your listings instead.");
  const open = await db.report.findFirst({ where: { reporterId, listingId: data.listingId, status: "OPEN" } });
  if (open) throw new UserError("You've already reported this listing. Our team will review it.");
  return db.report.create({ data: { reporterId, targetType: "LISTING", listingId: data.listingId, reason: data.reason, details: data.details } });
}

// ── saved searches and alerts ──
export const MAX_SAVED_SEARCHES = 20;

export async function saveSearch(db: Db, userId: string, input: { query: SearchQuery; label: string }) {
  const query = searchQuerySchema.parse({ ...input.query, page: undefined, sort: undefined });
  if (!query.q && !query.pn && !query.vehicle && !query.category) throw new UserError("Search for a part, part number, bike or category before saving the search.");
  const count = await db.savedSearch.count({ where: { userId } });
  if (count >= MAX_SAVED_SEARCHES) throw new UserError(`You can save up to ${MAX_SAVED_SEARCHES} searches. Delete one first.`);
  const label = input.label.trim().slice(0, 80) || "Saved search";
  return db.savedSearch.create({ data: { userId, label, query: JSON.parse(JSON.stringify(query)), lastCheckedAt: new Date() } });
}

export function listSavedSearches(db: Db, userId: string) {
  return db.savedSearch.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

export async function setSavedSearchAlerts(db: Db, userId: string, id: string, enabled: boolean) {
  const { count } = await db.savedSearch.updateMany({ where: { id, userId }, data: { alertsEnabled: enabled } });
  if (count === 0) throw new NotFoundError("saved search");
}

export async function deleteSavedSearch(db: Db, userId: string, id: string) {
  const { count } = await db.savedSearch.deleteMany({ where: { id, userId } });
  if (count === 0) throw new NotFoundError("saved search");
}

/**
 * Saved-search alerts (PLAN.md §5.1 L5 "trigger saved-search alerts"): when a listing goes LIVE, every
 * saved search with alerts on that now matches it gets an in-app notification (queued via the outbox).
 * Returns the ids of the matching saved searches.
 */
export async function matchSavedSearches(db: Db, listingId: string): Promise<Array<{ id: string; userId: string; label: string }>> {
  const listing = await db.listing.findFirst({ where: { id: listingId, status: "LIVE" }, select: { sellerId: true } });
  if (!listing) return [];
  const searches = await db.savedSearch.findMany({ where: { alertsEnabled: true, userId: { not: listing.sellerId } } });
  const matches: Array<{ id: string; userId: string; label: string }> = [];
  for (const s of searches) {
    const query = searchQuerySchema.safeParse(s.query);
    if (!query.success) continue;
    const r = await searchListings(db, query.data, { onlyListingIds: [listingId] });
    if (r.total > 0) matches.push({ id: s.id, userId: s.userId, label: s.label });
  }
  if (matches.length) await db.savedSearch.updateMany({ where: { id: { in: matches.map((m) => m.id) } }, data: { lastCheckedAt: new Date() } });
  return matches;
}

/** Worker job `searches.alert`: queue one in-app notification per matching saved search. Returns the count. */
export async function alertSavedSearches(db: Db, listingId: string): Promise<number> {
  const matches = await matchSavedSearches(db, listingId);
  if (!matches.length) return 0;
  const title = (await db.listing.findUnique({ where: { id: listingId }, select: { title: true } }))?.title ?? "A part";
  await db.$transaction(async (tx) => {
    for (const m of matches) {
      await enqueueOutbox(tx, {
        queue: "notifications",
        name: "send",
        payload: { userId: m.userId, channel: "IN_APP", type: "search.new_match", title: `New match for "${m.label}"`, body: `${title} was just listed.`, link: `/listings/${listingId}` },
      });
    }
  });
  return matches.length;
}
