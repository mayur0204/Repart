import { describe, expect, it, vi } from "vitest";
import { distanceKm, isPincode } from "@/lib/geo";
import { FIT_TONE, fitStatus, type FitInput } from "@/server/services/search/fit";

const bike = { variantId: "v1", label: "Sample Motors Roadster 200 Standard (2021)", shortLabel: "Roadster 200" };
const base: FitInput = { vehicle: bike, listingFitments: [], groupFitments: [], modificationFitments: [] };
const f = (source: "PART_NUMBER_MATCH" | "MECHANIC_CONFIRMED" | "BUYER_CONFIRMED" | "SELLER_DECLARED", verdict: "FITS" | "DOES_NOT_FIT" = "FITS", variantId = "v1") => ({ variantId, source, verdict });

describe("fitStatus matrix (PLAN.md §6.6, brief §10 wording)", () => {
  it("NO_VEHICLE when there is no bike", () => {
    expect(fitStatus({ ...base, vehicle: null, listingFitments: [f("PART_NUMBER_MATCH")] })).toMatchObject({ state: "NO_VEHICLE", headline: "Add your bike to check fit" });
  });

  it("FITS from a listing part-number match, with the source on the second line", () => {
    expect(fitStatus({ ...base, listingFitments: [f("PART_NUMBER_MATCH")] })).toMatchObject({
      state: "FITS",
      headline: "Fits your Sample Motors Roadster 200 Standard (2021)",
      detail: "Matched by part number",
    });
  });

  it("FITS from a mechanic confirmation or a group member's part-number fitment", () => {
    expect(fitStatus({ ...base, listingFitments: [f("MECHANIC_CONFIRMED")] }).detail).toBe("Confirmed by a mechanic");
    expect(fitStatus({ ...base, groupFitments: [f("PART_NUMBER_MATCH")] }).state).toBe("FITS");
    expect(fitStatus({ ...base, listingFitments: [f("BUYER_CONFIRMED")] }).detail).toBe("Confirmed by buyers");
  });

  it("MODIFICATION shows the note in full", () => {
    expect(fitStatus({ ...base, modificationFitments: [{ ...f("PART_NUMBER_MATCH"), notes: "Needs the longer mounting stem." }] })).toMatchObject({
      state: "MODIFICATION",
      detail: "Needs the longer mounting stem.",
    });
  });

  it("SELLER_SAYS when only the seller declared it", () => {
    expect(fitStatus({ ...base, listingFitments: [f("SELLER_DECLARED")] })).toMatchObject({
      state: "SELLER_SAYS",
      headline: "Seller says this fits your Roadster 200. Not confirmed by part number.",
    });
  });

  it("NOT_FIT wins over everything else", () => {
    const r = fitStatus({ ...base, listingFitments: [f("PART_NUMBER_MATCH"), f("SELLER_DECLARED")], groupFitments: [f("MECHANIC_CONFIRMED", "DOES_NOT_FIT")] });
    expect(r).toMatchObject({ state: "NOT_FIT", headline: "Does not fit your Roadster 200" });
  });

  it("precedence: confirmed fit beats modification beats seller-declared", () => {
    const mod = [{ ...f("PART_NUMBER_MATCH"), notes: "x" }];
    expect(fitStatus({ ...base, listingFitments: [f("SELLER_DECLARED")], modificationFitments: mod, groupFitments: [f("PART_NUMBER_MATCH")] }).state).toBe("FITS");
    expect(fitStatus({ ...base, listingFitments: [f("SELLER_DECLARED")], modificationFitments: mod }).state).toBe("MODIFICATION");
  });

  it("only fitments for the chosen bike count; no information is UNKNOWN", () => {
    expect(fitStatus({ ...base, listingFitments: [f("PART_NUMBER_MATCH", "FITS", "other")] }).state).toBe("UNKNOWN");
  });

  it("ranks for best-fit sorting and uses the §10 colours", () => {
    const rank = (i: FitInput) => fitStatus(i).rank;
    expect(rank({ ...base, listingFitments: [f("PART_NUMBER_MATCH")] })).toBeGreaterThan(rank({ ...base, listingFitments: [f("BUYER_CONFIRMED")] }));
    expect(rank({ ...base, listingFitments: [f("BUYER_CONFIRMED")] })).toBeGreaterThan(rank({ ...base, listingFitments: [f("SELLER_DECLARED")] }));
    expect(rank({ ...base, listingFitments: [f("SELLER_DECLARED")] })).toBeGreaterThan(rank({ ...base, modificationFitments: [{ ...f("PART_NUMBER_MATCH"), notes: "x" }] }));
    expect(FIT_TONE).toEqual({ FITS: "fit", SELLER_SAYS: "caution", MODIFICATION: "caution", NOT_FIT: "danger", NO_VEHICLE: "neutral", UNKNOWN: "neutral" });
  });
});

describe("distance", () => {
  it("haversine distance in km", () => {
    expect(distanceKm({ lat: 12.9, lng: 77.5 }, { lat: 12.9, lng: 77.5 })).toBe(0);
    expect(Math.round(distanceKm({ lat: 12.9716, lng: 77.5946 }, { lat: 13.0827, lng: 80.2707 }))).toBeGreaterThan(280);
    expect(isPincode("999901")).toBe(true);
    expect(isPincode("099901")).toBe(false);
  });
});

vi.mock("@/server/auth/current", () => ({ getCurrentUser: vi.fn(async () => null), clientIp: vi.fn(async () => "127.0.0.1") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("M6 member actions refuse signed-out users", async () => {
  const modules = { listings: await import("../../app/listings/actions"), search: await import("../../app/search/actions"), garage: await import("../../app/garage/actions") };
  const names = ["listings.toggleSaveListing", "listings.reportListing", "search.saveSearch", "garage.setSearchAlerts", "garage.deleteSavedSearch"];
  for (const name of names) {
    it(name, async () => {
      const [mod, fn] = name.split(".") as [keyof typeof modules, string];
      const action = (modules[mod] as Record<string, (p: null, f: FormData) => Promise<{ ok: boolean; message?: string } | null>>)[fn]!;
      expect(await action(null, new FormData())).toMatchObject({ ok: false, message: expect.stringMatching(/Sign in/) });
    }, 30_000);
  }
});
