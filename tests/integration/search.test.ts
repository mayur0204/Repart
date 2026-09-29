import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { createMockShippingProvider } from "../../src/server/adapters/shipping/mock";
import { createMemoryStorageProvider } from "../../src/server/adapters/storage/memory";
import { NotFoundError, UserError } from "../../src/server/http/errors";
import {
  alertSavedSearches,
  getPublicListing,
  getSellerProfile,
  listSavedListings,
  matchSavedSearches,
  reportListing,
  saveSearch,
  toggleSavedListing,
} from "../../src/server/services/search/public";
import { parseSearchQuery, resolveVehicle, searchListings, type SearchQuery } from "../../src/server/services/search/search";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const storage = createMemoryStorageProvider();
const deps = { storage, bucket: "listing-photos" };
const detailDeps = { ...deps, shipping: createMockShippingProvider({ webhookSecret: "test-secret-0123456789" }) };
const ids = (r: { tiles: Array<{ id: string }> }) => r.tiles.map((t) => t.id);
const search = (q: SearchQuery, vehicle = null as Awaited<ReturnType<typeof resolveVehicle>>) => searchListings(db, q, { deps, vehicle });

const TIER_A = "sample-listing-live-tier-a"; // mirrors, SAMPLE-MIR-0001, 999901, delivery, LIKE_NEW, SCREENED
const TIER_C = "sample-listing-live-tier-c"; // brake pads, SAMPLE-BRK-0003, seller bike Roadster 200 Standard
const LIGHTS = "sample-listing-live-tier-b-optional"; // lights, SAMPLE-LGT-0002
const PICKUP = "sample-listing-live-pickup-nopayout"; // local pickup, 999903

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
afterAll(async () => {
  await db.$disconnect();
});

describe("search by part number (normalised, interchange groups)", () => {
  it("finds listings for the whole group from a messy number, labelled with the match type", async () => {
    const r = await search({ pn: "sample brk 0001" });
    expect(r.partNumbers.map((p) => p.display)).toEqual(["SAMPLE-BRK-0001"]);
    expect(ids(r)).toContain(TIER_C);
    expect(ids(r)).not.toContain(TIER_A);
    expect(r.tiles.find((t) => t.id === TIER_C)?.match).toBe("Replaced by newer number (manufacturer catalogue)");
  });

  it("an unknown part number returns no results and says so", async () => {
    const r = await search({ pn: "NOT-A-REAL-NUMBER" });
    expect(r).toMatchObject({ unknownPartNumber: true, total: 0, tiles: [] });
  });

  it("a keyword finds by title, category or part number", async () => {
    expect(ids(await search({ q: "mirror" }))).toContain(TIER_A);
    expect(ids(await search({ q: "sample-mir 0001" }))).toContain(TIER_A);
    expect((await search({ q: "zzzz-no-such-thing" })).total).toBe(0);
  });
});

describe("search by vehicle and the fit line", () => {
  it("expands the bike's part-number fitments through groups and includes listings with their own fitment", async () => {
    const r = await search({ vehicle: "sample-variant-roadster-200-std", year: 2021 });
    expect(r.vehicle?.label).toBe("Sample Motors Roadster 200 Standard (2021)");
    expect(ids(r)).toEqual(expect.arrayContaining([TIER_C, TIER_A]));
    expect(ids(r)).not.toContain(LIGHTS);
    const fit = r.tiles.find((t) => t.id === TIER_C)!.fit;
    expect(fit).toMatchObject({ state: "FITS", headline: "Fits your Sample Motors Roadster 200 Standard (2021)", detail: "Matched by part number" });
  });

  it("an unknown vehicle id returns nothing rather than everything", async () => {
    expect((await search({ vehicle: "no-such-variant" })).total).toBe(0);
  });

  it("without a bike the fit line asks the user to add one", async () => {
    const r = await search({ q: "mirror" });
    expect(r.tiles.find((t) => t.id === TIER_A)?.fit.state).toBe("NO_VEHICLE");
  });
});

describe("filters, sort and distance", () => {
  it("applies category, condition, price, trust and delivery/pickup filters", async () => {
    expect(ids(await search({ category: "mirrors" })).every((id) => id !== LIGHTS && id !== TIER_C)).toBe(true);
    expect(ids(await search({ category: "mirrors" }))).toContain(TIER_A);
    expect(ids(await search({ condition: "LIKE_NEW" }))).toContain(TIER_A);
    expect(ids(await search({ condition: "FAIR" }))).not.toContain(TIER_A);
    expect(ids(await search({ min: 600, max: 700 }))).toEqual(expect.arrayContaining([TIER_A, TIER_C]));
    expect(ids(await search({ min: 600, max: 700 }))).not.toContain(LIGHTS);
    expect(ids(await search({ trust: "SELLER_DECLARED" }))).toContain(TIER_C);
    expect(ids(await search({ trust: "SELLER_DECLARED" }))).not.toContain(TIER_A);
    expect(ids(await search({ mode: "LOCAL_PICKUP" }))).toContain(PICKUP);
    expect(ids(await search({ mode: "LOCAL_PICKUP" }))).not.toContain(TIER_A);
  });

  it("only LIVE listings are ever returned", async () => {
    const statuses = await db.listing.findMany({ where: { id: { in: ids(await search({})) } }, select: { status: true } });
    expect(new Set(statuses.map((s) => s.status))).toEqual(new Set(["LIVE"]));
  });

  it("distance uses the SAMPLE pincode coordinates; unknown pincodes show no distance", async () => {
    const near = await search({ pin: "999901", distance: 10, sort: "nearest" });
    expect(ids(near)).toContain(TIER_A); // same pincode
    expect(ids(near)).not.toContain(PICKUP); // 999903 is about 34 km away
    expect(near.tiles.find((t) => t.id === TIER_A)?.distanceKm).toBe(0);
    const far = await search({ pin: "999901", distance: 50 });
    expect(far.tiles.find((t) => t.id === PICKUP)?.distanceKm).toBeGreaterThan(10);
    const unknown = await search({ pin: "560001" });
    expect(unknown.userPincodeKnown).toBe(false);
    expect(unknown.tiles.every((t) => t.distanceKm === null)).toBe(true);
  });

  it("sorts by price and newest", async () => {
    const byPrice = (await search({ sort: "price" })).tiles.map((t) => t.pricePaise);
    expect(byPrice).toEqual([...byPrice].sort((a, b) => a - b));
  });

  it("drops invalid URL parameters instead of failing", () => {
    expect(parseSearchQuery({ q: "mirror", min: "abc", sort: "sideways", distance: "7", pin: "12", condition: "SHINY", page: "0" })).toEqual({ q: "mirror" });
    expect(parseSearchQuery({ pn: ["SAMPLE-MIR-0001", "x"], distance: "25", sort: "nearest" })).toEqual({ pn: "SAMPLE-MIR-0001", distance: 25, sort: "nearest" });
  });
});

describe("public listing detail", () => {
  it("returns only public fields: no contact details, addresses, risk, admin, audit or storage data", async () => {
    const d = await getPublicListing(db, detailDeps, TIER_A, { vehicle: null, pincode: null });
    const json = JSON.stringify(d);
    for (const secret of ["+91555", "Sample building", "sampleaddr", "storageKey", "latestRiskScore", "riskAssessment", "sellerMessage", "pickupAddressId", "sellerId", "phone", "email", "version", "incomingKey", "pHash"]) {
      expect(json).not.toContain(secret);
    }
    expect(d).toMatchObject({ id: TIER_A, status: "LIVE", isSample: true, trustLabel: "SCREENED", inspectionRequirement: "NOT_NEEDED" });
    expect(d?.seller).toMatchObject({ displayName: "Sample", completedSales: expect.any(Number) });
    expect(d?.partNumber).toEqual({ display: "SAMPLE-MIR-0001", brand: "Sample Motors", isSample: true });
  });

  it("hides listings that aren't public (draft, submitted, changes needed, rejected, withdrawn)", async () => {
    for (const id of ["sample-listing-draft", "sample-listing-submitted", "sample-listing-changes", "sample-listing-rejected"]) {
      expect(await getPublicListing(db, detailDeps, id, { vehicle: null, pincode: null })).toBeNull();
    }
    expect((await getPublicListing(db, detailDeps, "sample-listing-reserved", { vehicle: null, pincode: null }))?.status).toBe("RESERVED");
  });

  it("keeps catalogue, seller-declared, modification and not-fit compatibility apart", async () => {
    const d = (await getPublicListing(db, detailDeps, TIER_A, { vehicle: null, pincode: null }))!;
    expect(d.compatibility.catalogue.map((v) => v.label)).toEqual(expect.arrayContaining(["Sample Motors Roadster 200 Standard (2019 to now)", "Sample Motors Roadster 200 ABS (2021 to now)"]));
    expect(d.compatibility.sellerDeclared.map((v) => v.label)).toEqual(["Sample Motors Roadster 200 ABS (2021 to now)"]);
    expect(d.equivalents.map((e) => e.label)).toEqual(expect.arrayContaining([expect.stringMatching(/^Equivalent/), expect.stringMatching(/^Fits with modification: SAMPLE note/)]));

    await db.fitment.create({ data: { listingId: TIER_A, variantId: "sample-variant-city-125-std", source: "MECHANIC_CONFIRMED", verdict: "DOES_NOT_FIT" } });
    const withNotFit = (await getPublicListing(db, detailDeps, TIER_A, { vehicle: await resolveVehicle(db, "sample-variant-city-125-std", 2020), pincode: null }))!;
    expect(withNotFit.compatibility.notFit.map((v) => v.label)).toEqual(["Sample Motors City 125 Standard (2017 to 2022)"]);
    expect(withNotFit.fit).toMatchObject({ state: "NOT_FIT", headline: "Does not fit your City 125" });
    await db.fitment.deleteMany({ where: { listingId: TIER_A, variantId: "sample-variant-city-125-std" } });
  });

  it("photos use short-lived signed URLs with shot-type captions; the delivery estimate uses the buyer's pincode", async () => {
    await db.listingPhoto.create({ data: { listingId: TIER_A, shotType: "front", sortOrder: 0, storageKey: `listings/${TIER_A}/p1.jpg`, processedAt: new Date(), width: 1200, height: 900 } });
    const d = (await getPublicListing(db, detailDeps, TIER_A, { vehicle: null, pincode: "999902" }))!;
    expect(d.photos[0]).toEqual({ url: `memory://download/listing-photos/listings/${TIER_A}/p1.jpg?ttl=600`, caption: expect.any(String) });
    expect(d.delivery?.amountPaise).toBeGreaterThan(0);
    expect(d.distanceKm).toBeGreaterThan(0);
    await db.listingPhoto.deleteMany({ where: { listingId: TIER_A, storageKey: { startsWith: `listings/${TIER_A}/` } } });
  });

  it("the seller profile shows first name, stats and live listings only", async () => {
    const p = await getSellerProfile(db, deps, "sample-user-seller");
    expect(p?.seller.displayName).toBe("Sample");
    expect(p?.tiles.map((t) => t.id)).toContain(TIER_A);
    expect(JSON.stringify(p)).not.toMatch(/\+91|phone|Sample building/);
    expect(await getSellerProfile(db, deps, "no-such-user")).toBeNull();
  });
});

describe("saved listings, reports and saved-search alerts", () => {
  const buyer = "sample-user-buyer";

  it("saves and unsaves a public listing; non-public listings can't be saved", async () => {
    expect(await toggleSavedListing(db, buyer, TIER_A)).toBe(true);
    expect((await listSavedListings(db, deps, buyer, null)).map((t) => t.id)).toContain(TIER_A);
    expect(await toggleSavedListing(db, buyer, TIER_A)).toBe(false);
    await expect(toggleSavedListing(db, buyer, "sample-listing-draft")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports: one open report per member and listing; sellers can't report themselves", async () => {
    const r = await reportListing(db, buyer, { listingId: LIGHTS, reason: "WRONG_PART", details: "Photo shows a different light." });
    expect(r).toMatchObject({ targetType: "LISTING", status: "OPEN", reason: "WRONG_PART" });
    await expect(reportListing(db, buyer, { listingId: LIGHTS, reason: "OTHER" })).rejects.toBeInstanceOf(UserError);
    await expect(reportListing(db, "sample-user-seller", { listingId: LIGHTS, reason: "OTHER" })).rejects.toThrow(/your own listing/);
    await expect(reportListing(db, buyer, { listingId: LIGHTS, reason: "BAD" })).rejects.toThrow();
  });

  it("a saved search with alerts matches a live listing and queues an in-app notification; the seller isn't alerted", async () => {
    await expect(saveSearch(db, buyer, { query: { sort: "price" }, label: "x" })).rejects.toBeInstanceOf(UserError);
    const s = await saveSearch(db, buyer, { query: { pn: "SAMPLE-MIR-0002" }, label: "Mirrors" });
    await saveSearch(db, "sample-user-seller", { query: { pn: "SAMPLE-MIR-0002" }, label: "Own" });
    const matches = await matchSavedSearches(db, TIER_A);
    expect(matches.map((m) => m.id)).toContain(s.id);
    expect(matches.every((m) => m.userId !== "sample-user-seller")).toBe(true);
    expect(await alertSavedSearches(db, TIER_A)).toBeGreaterThan(0);
    expect(await db.outboxJob.count({ where: { queue: "notifications", payload: { path: ["type"], equals: "search.new_match" } } })).toBeGreaterThan(0);
    expect(await matchSavedSearches(db, "sample-listing-draft")).toEqual([]);
  });
});
