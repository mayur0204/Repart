import type { FitmentSource, FitmentVerdict } from "@/generated/prisma/enums";

/**
 * fitStatus (PLAN.md §6.6, REPART_BRIEF.md §10 "fit status bar"), as a pure function.
 * Order of precedence, as in the plan:
 *  1. NOT_FIT      a DOES_NOT_FIT fitment exists for this listing or its part-number group, for the vehicle
 *  2. FITS         a PART_NUMBER_MATCH / MECHANIC_CONFIRMED (or BUYER_CONFIRMED) listing fitment, or a
 *                  FITS fitment on a group member (safety rules already applied to the group)
 *  3. MODIFICATION the part fits via a FITS_WITH_MODIFICATION link (one hop), note shown in full
 *  4. SELLER_SAYS  only a SELLER_DECLARED fitment
 *  5. NO_VEHICLE   the user has no bike to check against
 * UNKNOWN covers a chosen bike with no fit information at all (the brief's table has no row for it).
 */
export type FitState = "FITS" | "SELLER_SAYS" | "MODIFICATION" | "NOT_FIT" | "NO_VEHICLE" | "UNKNOWN";

export type Vehicle = { variantId: string; label: string; shortLabel: string };
export type FitmentFact = { variantId: string; source: FitmentSource; verdict: FitmentVerdict };

export type FitInput = {
  vehicle: Vehicle | null;
  /** Fitments recorded on the listing itself. */
  listingFitments: FitmentFact[];
  /** Part-number fitments on members of the listing's interchange group (incl. its own number). */
  groupFitments: FitmentFact[];
  /** Part-number fitments on one-hop FITS_WITH_MODIFICATION parts, with the link's note. */
  modificationFitments: Array<FitmentFact & { notes: string }>;
};

export type FitResult = { state: FitState; headline: string; detail: string | null; rank: number };

const SOURCE_TEXT: Record<FitmentSource, string> = {
  PART_NUMBER_MATCH: "Matched by part number",
  MECHANIC_CONFIRMED: "Confirmed by a mechanic",
  BUYER_CONFIRMED: "Confirmed by buyers",
  SELLER_DECLARED: "Seller-declared",
};

/** Ranking for "best fit": mechanic/part-number match > buyer-confirmed > seller-declared > modification. */
const SOURCE_RANK: Record<FitmentSource, number> = { MECHANIC_CONFIRMED: 6, PART_NUMBER_MATCH: 6, BUYER_CONFIRMED: 5, SELLER_DECLARED: 3 };
export const FIT_RANK: Record<FitState, number> = { FITS: 6, SELLER_SAYS: 3, MODIFICATION: 2, UNKNOWN: 1, NO_VEHICLE: 1, NOT_FIT: 0 };

export function fitStatus(input: FitInput): FitResult {
  const v = input.vehicle;
  if (!v) return { state: "NO_VEHICLE", headline: "Add your bike to check fit", detail: null, rank: FIT_RANK.NO_VEHICLE };
  const forBike = <T extends { variantId: string }>(xs: T[]) => xs.filter((x) => x.variantId === v.variantId);
  const own = forBike(input.listingFitments);
  const group = forBike(input.groupFitments);
  const mods = forBike(input.modificationFitments);

  if ([...own, ...group].some((f) => f.verdict === "DOES_NOT_FIT")) {
    return { state: "NOT_FIT", headline: `Does not fit your ${v.shortLabel}`, detail: null, rank: FIT_RANK.NOT_FIT };
  }
  const confirmed = [
    ...own.filter((f) => f.verdict === "FITS" && f.source !== "SELLER_DECLARED"),
    ...group.filter((f) => f.verdict === "FITS" && f.source !== "SELLER_DECLARED"),
  ].sort((a, b) => SOURCE_RANK[b.source] - SOURCE_RANK[a.source]);
  if (confirmed[0]) {
    return { state: "FITS", headline: `Fits your ${v.label}`, detail: SOURCE_TEXT[confirmed[0].source], rank: SOURCE_RANK[confirmed[0].source] };
  }
  const mod = mods.find((f) => f.verdict === "FITS");
  if (mod) return { state: "MODIFICATION", headline: `Fits your ${v.shortLabel} with a modification`, detail: mod.notes, rank: FIT_RANK.MODIFICATION };
  if (own.some((f) => f.source === "SELLER_DECLARED" && f.verdict === "FITS")) {
    return { state: "SELLER_SAYS", headline: `Seller says this fits your ${v.shortLabel}. Not confirmed by part number.`, detail: null, rank: FIT_RANK.SELLER_SAYS };
  }
  return { state: "UNKNOWN", headline: `No fit information for your ${v.shortLabel} yet`, detail: "Check the part number against your bike before buying.", rank: FIT_RANK.UNKNOWN };
}

/** Tone for the bar / tile line (§10 colour column). */
export const FIT_TONE: Record<FitState, "fit" | "caution" | "danger" | "neutral"> = {
  FITS: "fit",
  SELLER_SAYS: "caution",
  MODIFICATION: "caution",
  NOT_FIT: "danger",
  NO_VEHICLE: "neutral",
  UNKNOWN: "neutral",
};
