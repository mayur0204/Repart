import "server-only";
import { z } from "zod";
import type { ConditionGrade, FulfilmentMode, Prisma, PrismaClient, TrustLabel } from "@/generated/prisma/client";
import { distanceKm, isPincode } from "@/lib/geo";
import { normalizePartNumber } from "@/lib/part-number";
import type { StorageProvider } from "../../adapters/storage/types";
import { loadInterchange } from "../interchange/interchange";
import { matchLabel, type InterchangeResult, type Match } from "../interchange/graph";
import { fitStatus, type FitResult, type Vehicle } from "./fit";

/**
 * Public search (REPART_BRIEF.md §9 "Search results", PLAN.md §4.1 and §6.6).
 * URL parameters follow the plan: vehicle, pn, q, category, condition, min, max, distance, trust, mode, sort
 * (plus pin for the buyer's pincode and page). Only LIVE listings are returned. Uses Postgres through Prisma;
 * no separate search engine.
 */
type Db = PrismaClient;
export type PublicDeps = { storage: StorageProvider; bucket: string };

const opt = <T extends z.ZodType>(s: T) => s.optional().catch(undefined);
export const DISTANCES = [10, 25, 50, 100, 250] as const;
export const SORTS = ["best", "newest", "price", "nearest"] as const;
export const PAGE_SIZE = 24;

export const searchQuerySchema = z.object({
  q: opt(z.string().trim().min(1).max(80)),
  pn: opt(z.string().trim().min(1).max(60)),
  vehicle: opt(z.string().trim().min(1).max(40)),
  year: opt(z.coerce.number().int().min(1950).max(2100)),
  category: opt(z.string().regex(/^[a-z0-9-]{1,60}$/)),
  condition: opt(z.enum(["LIKE_NEW", "GOOD", "FAIR", "FOR_REPAIR"])),
  min: opt(z.coerce.number().min(0).max(10_000_000)),
  max: opt(z.coerce.number().min(0).max(10_000_000)),
  distance: opt(z.coerce.number().refine((d) => (DISTANCES as readonly number[]).includes(d))),
  trust: opt(z.enum(["PARTNER_CHECK", "SCREENED", "SELLER_DECLARED"])),
  mode: opt(z.enum(["DELIVERY", "LOCAL_PICKUP"])),
  sort: opt(z.enum(SORTS)),
  pin: opt(z.string().regex(/^[1-9]\d{5}$/)),
  page: opt(z.coerce.number().int().min(1).max(500)),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** Parses URL search params; anything invalid is dropped rather than failing the page. */
export function parseSearchQuery(params: Record<string, string | string[] | undefined>): SearchQuery {
  const flat = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v !== undefined && v !== ""));
  return searchQuerySchema.parse(flat);
}

export async function resolveVehicle(db: Pick<Db, "vehicleVariant">, variantId: string, year?: number | null): Promise<Vehicle | null> {
  const v = await db.vehicleVariant.findUnique({ where: { id: variantId }, include: { model: { include: { make: true } } } });
  if (!v) return null;
  return { variantId: v.id, label: `${v.model.make.name} ${v.model.name} ${v.name}${year ? ` (${year})` : ""}`, shortLabel: v.model.name };
}

/** Per-request memo so each part number's group is loaded once. */
function interchangeMemo(db: Db) {
  const cache = new Map<string, Promise<InterchangeResult>>();
  return (id: string) => {
    if (!cache.has(id)) cache.set(id, loadInterchange(db, id));
    return cache.get(id)!;
  };
}

const MATCH_ORDER: Record<Match["kind"], number> = { SAME: 4, EQUIVALENT: 3, NEWER: 3, OLDER: 3, MODIFICATION: 1 };

export type Tile = {
  id: string;
  title: string;
  pricePaise: number;
  grade: ConditionGrade | null;
  fulfilmentMode: FulfilmentMode;
  trustLabel: TrustLabel;
  isSample: boolean;
  categoryName: string | null;
  location: string | null;
  distanceKm: number | null;
  photoUrl: string | null;
  fit: FitResult;
  /** Part-number search only: how this listing's number relates to the searched number. */
  match: string | null;
  liveAt: Date | null;
};

const tileSelect = {
  id: true,
  title: true,
  pricePaise: true,
  conditionGrade: true,
  fulfilmentMode: true,
  trustLabel: true,
  isSample: true,
  pickupPincode: true,
  partNumberId: true,
  liveAt: true,
  category: { select: { name: true } },
  fitments: { select: { variantId: true, source: true, verdict: true } },
  photos: { where: { storageKey: { not: null } }, orderBy: { sortOrder: "asc" as const }, take: 1, select: { storageKey: true } },
} satisfies Prisma.ListingSelect;

type Row = Prisma.ListingGetPayload<{ select: typeof tileSelect }>;

/** Fit status for many listings against one vehicle, with the group/modification data loaded in bulk. */
export async function fitsFor(db: Db, rows: Array<Pick<Row, "id" | "partNumberId" | "fitments">>, vehicle: Vehicle | null, groups = interchangeMemo(db)) {
  const out = new Map<string, FitResult>();
  if (!vehicle) {
    for (const r of rows) out.set(r.id, fitStatus({ vehicle: null, listingFitments: [], groupFitments: [], modificationFitments: [] }));
    return out;
  }
  const pnIds = [...new Set(rows.map((r) => r.partNumberId).filter((x): x is string => !!x))];
  const results = new Map(await Promise.all(pnIds.map(async (id) => [id, await groups(id)] as const)));
  const allIds = [...new Set([...results.values()].flatMap((r) => [...r.group, ...r.modifications].map((m) => m.partNumberId)))];
  const pnFitments = await db.fitment.findMany({ where: { variantId: vehicle.variantId, listingId: null, partNumberId: { in: allIds } }, select: { partNumberId: true, variantId: true, source: true, verdict: true } });
  for (const r of rows) {
    const ix = r.partNumberId ? results.get(r.partNumberId) : undefined;
    const members = new Set(ix?.group.map((m) => m.partNumberId) ?? []);
    const modNotes = new Map(ix?.modifications.map((m) => [m.partNumberId, m.notes ?? ""]) ?? []);
    out.set(
      r.id,
      fitStatus({
        vehicle,
        listingFitments: r.fitments,
        groupFitments: pnFitments.filter((f) => members.has(f.partNumberId!)),
        modificationFitments: pnFitments.filter((f) => modNotes.has(f.partNumberId!)).map((f) => ({ ...f, notes: modNotes.get(f.partNumberId!)! })),
      }),
    );
  }
  return out;
}

export type SearchResult = {
  query: SearchQuery;
  tiles: Tile[];
  total: number;
  page: number;
  pages: number;
  /** The searched part number isn't in the catalogue. */
  unknownPartNumber: boolean;
  /** Catalogue numbers that matched the pn search (for "see part page" links). */
  partNumbers: Array<{ id: string; display: string; brand: string; isSample: boolean }>;
  vehicle: Vehicle | null;
  userPincodeKnown: boolean;
};

/**
 * Runs a search. `vehicle` is the bike used for the fit line: the searched vehicle, else the caller's
 * primary garage bike, else none. `onlyListingIds` restricts the search (used by saved-search alerts).
 */
export async function searchListings(
  db: Db,
  query: SearchQuery,
  opts: { vehicle?: Vehicle | null; deps?: PublicDeps; onlyListingIds?: string[] } = {},
): Promise<SearchResult> {
  const groups = interchangeMemo(db);
  const and: Prisma.ListingWhereInput[] = [{ status: "LIVE" }];
  if (opts.onlyListingIds) and.push({ id: { in: opts.onlyListingIds } });
  const matchByPn = new Map<string, Match>();
  let partNumbers: SearchResult["partNumbers"] = [];

  // Part number: normalise → catalogue numbers → groups + one-hop modifications (§6.6).
  if (query.pn) {
    const normalized = normalizePartNumber(query.pn);
    partNumbers = await db.partNumber.findMany({ where: { normalized }, select: { id: true, display: true, brand: true, isSample: true } });
    if (partNumbers.length === 0) return emptyResult(query, true, opts.vehicle ?? null);
    for (const pn of partNumbers) {
      const r = await groups(pn.id);
      for (const m of [...r.group, ...r.modifications]) {
        const prev = matchByPn.get(m.partNumberId);
        if (!prev || MATCH_ORDER[m.kind] > MATCH_ORDER[prev.kind]) matchByPn.set(m.partNumberId, m);
      }
    }
    and.push({ OR: [{ partNumberId: { in: [...matchByPn.keys()] } }, { partNumberEntered: { in: partNumbers.map((p) => p.display) } }] });
  }

  // Vehicle: its part-number fitments expanded through groups, plus listings with their own fitment (§6.6).
  const searchVehicle = query.vehicle ? await resolveVehicle(db, query.vehicle, query.year) : null;
  if (query.vehicle) {
    if (!searchVehicle) return emptyResult(query, false, null);
    const fits = await db.fitment.findMany({ where: { variantId: searchVehicle.variantId, verdict: "FITS", partNumberId: { not: null }, listingId: null }, select: { partNumberId: true } });
    const expanded = new Set<string>();
    for (const f of fits) {
      const r = await groups(f.partNumberId!);
      for (const m of [...r.group, ...r.modifications]) expanded.add(m.partNumberId);
    }
    and.push({
      OR: [{ partNumberId: { in: [...expanded] } }, { fitments: { some: { variantId: searchVehicle.variantId, verdict: "FITS" } } }],
      NOT: { fitments: { some: { variantId: searchVehicle.variantId, verdict: "DOES_NOT_FIT" } } },
    });
  }

  if (query.q) {
    and.push({
      OR: [
        { title: { contains: query.q, mode: "insensitive" } },
        { partName: { contains: query.q, mode: "insensitive" } },
        { category: { name: { contains: query.q, mode: "insensitive" } } },
        { partNumber: { normalized: { contains: normalizePartNumber(query.q) } } },
      ],
    });
  }
  if (query.category) and.push({ category: { OR: [{ slug: query.category }, { parent: { slug: query.category } }] } });
  if (query.condition) and.push({ conditionGrade: query.condition });
  if (query.min !== undefined) and.push({ pricePaise: { gte: Math.round(query.min * 100) } });
  if (query.max !== undefined) and.push({ pricePaise: { lte: Math.round(query.max * 100) } });
  if (query.trust) and.push({ trustLabel: query.trust });
  if (query.mode) and.push({ fulfilmentMode: query.mode });

  const rows = await db.listing.findMany({ where: { AND: and }, select: tileSelect, orderBy: { liveAt: "desc" }, take: 1000 });

  // Distance (assumption A-24: only pincodes in PincodeGeo have coordinates; others show no distance).
  const pins = [...new Set([query.pin, ...rows.map((r) => r.pickupPincode)].filter(isPincode))];
  const geo = new Map((await db.pincodeGeo.findMany({ where: { pincode: { in: pins } } })).map((g) => [g.pincode, g]));
  const origin = query.pin ? geo.get(query.pin) : undefined;

  const vehicle = searchVehicle ?? opts.vehicle ?? null;
  const fits = await fitsFor(db, rows, vehicle, groups);

  let tiles: Tile[] = rows.map((r) => {
    const place = r.pickupPincode ? geo.get(r.pickupPincode) : undefined;
    const match = r.partNumberId ? matchByPn.get(r.partNumberId) : undefined;
    return {
      id: r.id,
      title: r.title ?? "Untitled part",
      pricePaise: r.pricePaise ?? 0,
      grade: r.conditionGrade,
      fulfilmentMode: r.fulfilmentMode,
      trustLabel: r.trustLabel,
      isSample: r.isSample,
      categoryName: r.category?.name ?? null,
      location: place?.district ?? (r.pickupPincode ? `Pincode ${r.pickupPincode}` : null),
      distanceKm: origin && place ? Math.round(distanceKm(origin, place)) : null,
      photoUrl: null,
      fit: fits.get(r.id)!,
      match: match ? matchLabel(match) : null,
      liveAt: r.liveAt,
    };
  });

  if (query.distance !== undefined && origin) tiles = tiles.filter((t) => t.distanceKm !== null && t.distanceKm <= query.distance!);

  const sort = query.sort ?? (query.pn || vehicle ? "best" : "newest");
  const newest = (a: Tile, b: Tile) => (b.liveAt?.getTime() ?? 0) - (a.liveAt?.getTime() ?? 0);
  tiles.sort(
    sort === "price"
      ? (a, b) => a.pricePaise - b.pricePaise || newest(a, b)
      : sort === "nearest"
        ? (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || newest(a, b)
        : sort === "best"
          ? (a, b) => b.fit.rank - a.fit.rank || newest(a, b)
          : newest,
  );

  const page = query.page ?? 1;
  const total = tiles.length;
  const pageTiles = tiles.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  if (opts.deps) {
    const keys = new Map(rows.map((r) => [r.id, r.photos[0]?.storageKey ?? null]));
    await Promise.all(
      pageTiles.map(async (t) => {
        const key = keys.get(t.id);
        if (key) t.photoUrl = await opts.deps!.storage.createSignedDownloadUrl(opts.deps!.bucket, key, 600);
      }),
    );
  }
  return { query, tiles: pageTiles, total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), unknownPartNumber: false, partNumbers, vehicle, userPincodeKnown: !!origin };
}

function emptyResult(query: SearchQuery, unknownPartNumber: boolean, vehicle: Vehicle | null): SearchResult {
  return { query, tiles: [], total: 0, page: 1, pages: 1, unknownPartNumber, partNumbers: [], vehicle, userPincodeKnown: false };
}

