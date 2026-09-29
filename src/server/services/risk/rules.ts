import { createHash } from "node:crypto";
import type { InspectionReason, InspectionRequirement, InspectionTier, TrustLabel } from "@/generated/prisma/enums";
import { detectContactDetails, gradeFromChecklist, hammingDistance, type ChecklistAnswers, type ChecklistItem, type StepSlug } from "@/lib/listing";
import { normalizePartNumber } from "@/lib/part-number";
import type { CategoryResult, DamageResult, OcrResult } from "../../adapters/vision/types";
import type { Settings } from "../settings/schema";
import type { StepReport } from "../listing/steps";

/**
 * Risk check rules (REPART_BRIEF.md §6, PLAN.md §6.1–6.3), as pure functions.
 * Codes, severities and routing follow the plan's tables exactly; every threshold and weight
 * comes from the active settings version, whose number is stored as the ruleSetVersion.
 */
export type Severity = "HARD" | "SOFT" | "INFO";
export type CheckResult = {
  code: string;
  passed: boolean;
  severity: Severity;
  /** 0–1; vision checks use the provider's confidence, other checks 1. */
  confidence: number;
  message: string;
  fixStep?: StepSlug;
  photoId?: string;
};

export type RiskPhoto = {
  id: string;
  /** 1-based position, as the seller sees it. */
  index: number;
  shotLabel: string;
  shotType: string;
  ready: boolean;
  width: number | null;
  height: number | null;
  blurScore: number | null;
  brightnessScore: number | null;
  pHash: string | null;
};

export type RiskContext = {
  listing: {
    id: string;
    sellerId: string;
    title: string | null;
    description: string | null;
    reasonForSale: string | null;
    pricePaise: number | null;
    checklistAnswers: unknown;
    partNumberDisplay: string | null;
  };
  category: { slug: string; checklist: ChecklistItem[]; requiredShots: Array<{ shotType: string; label: string }> };
  steps: StepReport;
  photos: RiskPhoto[];
  /** Processed photos of other listings, for DUPLICATE_PHOTO. */
  otherPhotos: Array<{ listingId: string; sellerId: string; pHash: string }>;
  /** Prices of comparable LIVE/SOLD listings (same category + grade, + part-number group when present). */
  comparablePrices: number[];
  settings: Settings;
};

const ok = (code: string, severity: Severity, message = ""): CheckResult => ({ code, passed: true, severity, confidence: 1, message });
const fail = (code: string, severity: Severity, message: string, extra: Partial<CheckResult> = {}): CheckResult => ({ code, passed: false, severity, confidence: 1, message, ...extra });
const photoName = (p: RiskPhoto) => `Photo ${p.index} (${p.shotLabel})`;

// ───────────────────────────── Stage 1 ─────────────────────────────

function requiredFields(ctx: RiskContext): CheckResult[] {
  const steps: StepSlug[] = ["bike", "part", "details", "price"];
  const out = steps.flatMap((s) => ctx.steps[s].map((m) => fail("REQUIRED_FIELDS", "HARD", m, { fixStep: s })));
  const { unanswered } = gradeFromChecklist(ctx.category.checklist, (ctx.listing.checklistAnswers ?? {}) as ChecklistAnswers, ctx.settings.grading);
  if (unanswered.length) out.push(fail("REQUIRED_FIELDS", "HARD", `Answer all ${ctx.category.checklist.length} checklist questions.`, { fixStep: "condition" }));
  return out.length ? out : [ok("REQUIRED_FIELDS", "HARD")];
}

function photoGuide(ctx: RiskContext): CheckResult[] {
  const ready = ctx.photos.filter((p) => p.ready);
  const out: CheckResult[] = [];
  const min = ctx.settings.risk.minPhotos;
  if (ready.length < min) out.push(fail("PHOTO_GUIDE", "HARD", `Add at least ${min} photos. This listing has ${ready.length}.`, { fixStep: "photos" }));
  for (const shot of ctx.category.requiredShots) {
    if (!ready.some((p) => p.shotType === shot.shotType)) out.push(fail("PHOTO_GUIDE", "HARD", `Add the "${shot.label}" photo from the shot list.`, { fixStep: "photos" }));
  }
  return out.length ? out : [ok("PHOTO_GUIDE", "HARD")];
}

function perPhoto(ctx: RiskContext): CheckResult[] {
  const r = ctx.settings.risk;
  const out: CheckResult[] = [];
  for (const p of ctx.photos.filter((x) => x.ready)) {
    const at = { fixStep: "photos" as const, photoId: p.id };
    const shortSide = Math.min(p.width ?? 0, p.height ?? 0);
    out.push(
      shortSide >= r.minPhotoShortSidePx
        ? { ...ok("MIN_RESOLUTION", "HARD"), photoId: p.id }
        : fail("MIN_RESOLUTION", "HARD", `${photoName(p)} is too small (${shortSide} px on its shortest side). Retake it closer, at your camera's full resolution.`, at),
    );
    out.push(
      (p.blurScore ?? 0) >= r.blurThreshold
        ? { ...ok("BLUR", "HARD"), photoId: p.id }
        : fail("BLUR", "HARD", `${photoName(p)} is blurry. Retake it in daylight, holding the phone steady.`, at),
    );
    const b = p.brightnessScore ?? 0;
    out.push(
      b >= r.minBrightness && b <= r.maxBrightness
        ? { ...ok("BRIGHTNESS", "HARD"), photoId: p.id }
        : fail("BRIGHTNESS", "HARD", b < r.minBrightness ? `${photoName(p)} is too dark. Retake it in daylight or under brighter light.` : `${photoName(p)} is too bright. Retake it out of direct sunlight and without flash.`, at),
    );
  }
  return out;
}

function duplicatePhotos(ctx: RiskContext): CheckResult[] {
  const out: CheckResult[] = [];
  for (const p of ctx.photos.filter((x) => x.ready && x.pHash)) {
    const matches = ctx.otherPhotos.filter((o) => o.listingId !== ctx.listing.id && hammingDistance(o.pHash, p.pHash!) <= ctx.settings.risk.phashMaxDistance);
    if (matches.some((m) => m.sellerId !== ctx.listing.sellerId)) {
      out.push(fail("DUPLICATE_PHOTO", "HARD", `${photoName(p)} matches a photo in another seller's listing. Use your own photos of this part.`, { fixStep: "photos", photoId: p.id }));
    } else if (matches.length) {
      out.push(fail("DUPLICATE_PHOTO_OWN", "SOFT", `${photoName(p)} matches a photo from one of this seller's other listings.`, { photoId: p.id }));
    }
  }
  return out.length ? out : [ok("DUPLICATE_PHOTO", "HARD")];
}

/** Robust z-score (median / MAD) against comparables; skipped with fewer than minComparables. */
export function priceOutlier(price: number | null, comparables: number[], minComparables: number, zLimit: number): CheckResult {
  if (price === null || comparables.length < minComparables) return { ...ok("PRICE_OUTLIER", "SOFT", `Skipped: ${comparables.length} comparable listings, ${minComparables} needed.`), severity: "INFO" };
  const sorted = [...comparables].sort((a, b) => a - b);
  const med = (xs: number[]) => (xs.length % 2 ? xs[(xs.length - 1) / 2]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2);
  const m = med(sorted);
  const mad = med(sorted.map((x) => Math.abs(x - m)).sort((a, b) => a - b)) || Math.max(1, m * 0.01);
  const z = (0.6745 * (price - m)) / mad;
  return Math.abs(z) > zLimit
    ? fail("PRICE_OUTLIER", "SOFT", `Price is far from ${comparables.length} comparable listings (robust z ${z.toFixed(1)}, median ₹${Math.round(m / 100)}).`)
    : ok("PRICE_OUTLIER", "SOFT");
}

function blockingChecklist(ctx: RiskContext): CheckResult[] {
  const { blocking } = gradeFromChecklist(ctx.category.checklist, (ctx.listing.checklistAnswers ?? {}) as ChecklistAnswers, ctx.settings.grading);
  return blocking.length
    ? blocking.map((q) => fail("BLOCKING_CHECKLIST", "HARD", `Parts where the answer to "${q}" shows this fault can't be listed.`, { fixStep: "condition" }))
    : [ok("BLOCKING_CHECKLIST", "HARD")];
}

function contactDetails(ctx: RiskContext): CheckResult {
  const found = detectContactDetails([ctx.listing.title, ctx.listing.description, ctx.listing.reasonForSale].filter(Boolean).join("\n"));
  return found.length ? fail("CONTACT_DETAILS", "SOFT", `Contact details were masked (${found.join(", ")}).`) : ok("CONTACT_DETAILS", "SOFT");
}

export function stage1(ctx: RiskContext): CheckResult[] {
  const r = ctx.settings.risk;
  return [
    ...requiredFields(ctx),
    ...photoGuide(ctx),
    ...perPhoto(ctx),
    ...duplicatePhotos(ctx),
    priceOutlier(ctx.listing.pricePaise, ctx.comparablePrices, r.minComparables, r.priceOutlierZ),
    ...blockingChecklist(ctx),
    contactDetails(ctx),
  ];
}

// ───────────────────────────── Stage 2 ─────────────────────────────

export type VisionPhotoResult = { photoId: string; index: number; category: CategoryResult; damage: DamageResult; ocr: OcrResult };

/**
 * DAMAGE_CONTRADICTION reads "the checklist says no damage" as: no checklist answer was the bad one
 * (the category checklists are the damage questions). See the M5 report, assumption 2.
 */
export function stage2(ctx: RiskContext, vision: VisionPhotoResult[]): CheckResult[] {
  const min = ctx.settings.risk.visionMinConfidence;
  const out: CheckResult[] = [];

  const mismatches = vision.filter((v) => v.category.categorySlug && v.category.categorySlug !== ctx.category.slug && v.category.confidence >= min);
  const worst = mismatches.sort((a, b) => b.category.confidence - a.category.confidence)[0];
  out.push(
    worst
      ? { ...fail("CATEGORY_MISMATCH", "SOFT", `Photo ${worst.index} looks like ${worst.category.categorySlug}, not ${ctx.category.slug}.`, { photoId: worst.photoId }), confidence: worst.category.confidence }
      : ok("CATEGORY_MISMATCH", "SOFT"),
  );

  const answers = (ctx.listing.checklistAnswers ?? {}) as ChecklistAnswers;
  const checklistClean = ctx.category.checklist.every((i) => answers[i.id] !== i.badAnswer);
  const damaged = vision
    .map((v) => ({ v, top: [...v.damage.damage].sort((a, b) => b.score - a.score)[0] }))
    .filter((d) => d.top && d.top.score >= min && d.v.damage.confidence >= min)
    .sort((a, b) => b.top!.score - a.top!.score)[0];
  out.push(
    checklistClean && damaged
      ? { ...fail("DAMAGE_CONTRADICTION", "SOFT", `Photo ${damaged.v.index} shows possible ${damaged.top!.kind.toLowerCase()} damage, but the checklist reports no faults.`, { photoId: damaged.v.photoId }), confidence: damaged.top!.score }
      : ok("DAMAGE_CONTRADICTION", "SOFT"),
  );

  const entered = ctx.listing.partNumberDisplay ? normalizePartNumber(ctx.listing.partNumberDisplay) : null;
  const read = vision.filter((v) => v.ocr.confidence >= min).flatMap((v) => v.ocr.text.map((t) => ({ v, text: normalizePartNumber(t) }))).filter((r) => r.text.length >= 4);
  if (!entered || read.length === 0) out.push({ ...ok("PART_NUMBER_OCR", "SOFT", "No part number read from the photos."), severity: "INFO" });
  else if (read.some((r) => r.text.includes(entered))) out.push({ ...ok("PART_NUMBER_OCR", "SOFT", "The part number in the photos matches the entered number."), severity: "INFO" });
  else out.push({ ...fail("PART_NUMBER_OCR", "SOFT", `The photos show "${read[0]!.text}", which differs from the entered part number.`, { photoId: read[0]!.v.photoId }), confidence: read[0]!.v.ocr.confidence });
  return out;
}

// ───────────────────────────── Stage 3 ─────────────────────────────

/** score = min(100, Σ weight × confidence of failed SOFT checks). */
export function riskScore(checks: CheckResult[], weights: Record<string, number>): number {
  const total = checks.filter((c) => !c.passed && c.severity === "SOFT").reduce((sum, c) => sum + (weights[c.code] ?? 0) * c.confidence, 0);
  return Math.min(100, Math.round(total));
}

export type CategoryRules = { inspectionTier: InspectionTier; inspectionValueThreshold: number | null; optionalCheckEnabled: boolean };

/** PLAN.md §6.2 computeInspectionRequirement, in the table's order. */
export function inspectionRequirement(category: CategoryRules, pricePaise: number, score: number, settings: Settings): { requirement: InspectionRequirement; reason: InspectionReason | null } {
  if (category.inspectionTier === "C_ALWAYS") return { requirement: "REQUIRED", reason: "TIER_C" };
  if (category.inspectionTier === "B_CONDITIONAL") {
    if (category.inspectionValueThreshold !== null && pricePaise >= category.inspectionValueThreshold) return { requirement: "REQUIRED", reason: "TIER_B_THRESHOLD" };
    if (score >= settings.inspections.riskThresholdTierB) return { requirement: "REQUIRED", reason: "HIGH_RISK" };
    return { requirement: "OPTIONAL", reason: null };
  }
  return { requirement: category.optionalCheckEnabled ? "OPTIONAL" : "NOT_NEEDED", reason: null };
}

/** PLAN.md §6.2 trust label on screening. PARTNER_CHECK needs a passed inspection (M10). */
export function trustLabel(hadHardFailure: boolean, score: number, settings: Settings): TrustLabel {
  return !hadHardFailure && score < settings.risk.lowRiskThreshold ? "SCREENED" : "SELLER_DECLARED";
}

export type RoutingResult = {
  decision: "CHANGES_REQUESTED" | "LIVE";
  score: number;
  hadHardFailure: boolean;
  requirement: InspectionRequirement | null;
  reason: InspectionReason | null;
  trustLabel: TrustLabel | null;
  /** D-5: high score or any SOFT flag sends a LIVE listing to the admin review queue too. */
  needsAdminReview: boolean;
  reviewReasons: string[];
};

export function route(checks: CheckResult[], category: CategoryRules, pricePaise: number, settings: Settings): RoutingResult {
  const hadHardFailure = checks.some((c) => !c.passed && c.severity === "HARD");
  const score = riskScore(checks, settings.risk.weights);
  if (hadHardFailure) {
    return { decision: "CHANGES_REQUESTED", score, hadHardFailure, requirement: null, reason: null, trustLabel: null, needsAdminReview: false, reviewReasons: [] };
  }
  const softFlags = checks.filter((c) => !c.passed && c.severity === "SOFT");
  const reviewReasons = [...(score >= settings.risk.adminReviewThreshold ? [`Risk score ${score} is at or above ${settings.risk.adminReviewThreshold}.`] : []), ...softFlags.map((c) => c.message)];
  const { requirement, reason } = inspectionRequirement(category, pricePaise, score, settings);
  return { decision: "LIVE", score, hadHardFailure, requirement, reason, trustLabel: trustLabel(false, score, settings), needsAdminReview: reviewReasons.length > 0, reviewReasons };
}

// ───────────────────────────── Audit sampling (PLAN.md §6.3) ─────────────────────────────

/**
 * Deterministic audit selection for an order that would not otherwise be inspected:
 * hash(orderId + settingsVersion) mod 10000 < auditPercent × 100. Applied at order time (O4, M8+),
 * not at listing screening; defined here with the other inspection rules so it's tested now.
 */
export function selectedForAudit(orderId: string, settingsVersion: number, auditPercent: number): boolean {
  const n = parseInt(createHash("sha256").update(`${orderId}:${settingsVersion}`).digest("hex").slice(0, 8), 16) % 10000;
  return n < Math.round(auditPercent * 100);
}
