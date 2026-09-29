import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { maskContactDetails, type ChecklistItem } from "@/lib/listing";
import { createMockVisionProvider, imageHash } from "@/server/adapters/vision/mock";
import {
  inspectionRequirement,
  priceOutlier,
  riskScore,
  route,
  selectedForAudit,
  stage1,
  stage2,
  trustLabel,
  type CheckResult,
  type RiskContext,
  type RiskPhoto,
  type VisionPhotoResult,
} from "@/server/services/risk/rules";
import { DEFAULT_SETTINGS } from "@/server/services/settings/schema";

const settings = structuredClone(DEFAULT_SETTINGS);
const checklist: ChecklistItem[] = [
  { id: "cracks", question: "Any cracks?", weight: 40, badAnswer: "YES", blocksListing: false },
  { id: "worn", question: "Worn below the limit?", weight: 25, badAnswer: "YES", blocksListing: true },
];
const photo = (i: number, over: Partial<RiskPhoto> = {}): RiskPhoto => ({
  id: `p${i}`,
  index: i,
  shotLabel: ["Front", "Back", "Label"][i - 1] ?? "extra photo",
  shotType: ["front", "back", "label"][i - 1] ?? "extra",
  ready: true,
  width: 1200,
  height: 900,
  blurScore: 400,
  brightnessScore: 120,
  pHash: `${i}`.repeat(16).slice(0, 16).replace(/[^0-9a-f]/g, "0"),
  ...over,
});
const noSteps = { bike: [], part: [], condition: [], photos: [], details: [], price: [], review: [] };

function ctx(over: Partial<RiskContext> = {}, listing: Partial<RiskContext["listing"]> = {}): RiskContext {
  return {
    listing: { id: "L", sellerId: "S", title: "Pads", description: "Even wear, no cracks.", reasonForSale: null, pricePaise: 80000, checklistAnswers: { cracks: "NO", worn: "NO" }, partNumberDisplay: "SAMPLE-BRK-0001", ...listing },
    category: { slug: "brake-pads", checklist, requiredShots: [{ shotType: "front", label: "Front" }, { shotType: "label", label: "Label" }] },
    steps: noSteps,
    photos: [photo(1, { pHash: "0000000000000000" }), photo(2, { pHash: "ffffffffffffffff" }), photo(3, { pHash: "00000000ffffffff" })],
    otherPhotos: [],
    comparablePrices: [],
    settings,
    ...over,
  };
}
const failed = (checks: CheckResult[], code: string) => checks.filter((c) => c.code === code && !c.passed);

describe("Stage 1 rules (PLAN.md §6.1), one test per rule", () => {
  it("a clean listing passes every Stage 1 rule", () => {
    expect(stage1(ctx()).filter((c) => !c.passed)).toEqual([]);
  });

  it("REQUIRED_FIELDS: missing step fields and unanswered checklist are HARD with a fix step", () => {
    const r = failed(stage1(ctx({ steps: { ...noSteps, price: ["Set a price."] } }, { checklistAnswers: { cracks: "NO" } })), "REQUIRED_FIELDS");
    expect(r.map((c) => [c.severity, c.fixStep])).toEqual([["HARD", "price"], ["HARD", "condition"]]);
  });

  it("PHOTO_GUIDE: fewer than minPhotos or a missing required shot is HARD", () => {
    const r = failed(stage1(ctx({ photos: [photo(1, { pHash: "0000000000000000" }), photo(2, { pHash: "ffffffffffffffff" })] })), "PHOTO_GUIDE");
    expect(r.map((c) => c.message)).toEqual(["Add at least 3 photos. This listing has 2.", 'Add the "Label" photo from the shot list.']);
  });

  it("MIN_RESOLUTION, BLUR and BRIGHTNESS are HARD per photo and name the photo with a retake tip", () => {
    const photos = [photo(1, { width: 600, height: 500, pHash: "0000000000000000" }), photo(2, { blurScore: 10, pHash: "ffffffffffffffff" }), photo(3, { brightnessScore: 20, pHash: "00000000ffffffff" })];
    const checks = stage1(ctx({ photos }));
    expect(failed(checks, "MIN_RESOLUTION")[0]).toMatchObject({ severity: "HARD", photoId: "p1", fixStep: "photos", message: expect.stringMatching(/^Photo 1 \(Front\) is too small \(500 px/) });
    expect(failed(checks, "BLUR")[0]?.message).toBe("Photo 2 (Back) is blurry. Retake it in daylight, holding the phone steady.");
    expect(failed(checks, "BRIGHTNESS")[0]?.message).toMatch(/^Photo 3 \(Label\) is too dark/);
    expect(failed(stage1(ctx({ photos: [photo(1, { brightnessScore: 250, pHash: "0000000000000000" }), ...ctx().photos.slice(1)] })), "BRIGHTNESS")[0]?.message).toMatch(/too bright/);
  });

  it("DUPLICATE_PHOTO: another seller's near-identical photo is HARD; the same seller's is SOFT", () => {
    const near = "0000000000000003"; // 2 bits from photo 1
    expect(failed(stage1(ctx({ otherPhotos: [{ listingId: "X", sellerId: "OTHER", pHash: near }] })), "DUPLICATE_PHOTO")[0]).toMatchObject({ severity: "HARD", photoId: "p1" });
    const own = stage1(ctx({ otherPhotos: [{ listingId: "X", sellerId: "S", pHash: near }] }));
    expect(failed(own, "DUPLICATE_PHOTO")).toEqual([]);
    expect(failed(own, "DUPLICATE_PHOTO_OWN")[0]?.severity).toBe("SOFT");
    expect(failed(stage1(ctx({ otherPhotos: [{ listingId: "X", sellerId: "OTHER", pHash: "0000000000ffff00" }] })), "DUPLICATE_PHOTO")).toEqual([]); // far
  });

  it("PRICE_OUTLIER: skipped below minComparables; robust z against the median", () => {
    expect(priceOutlier(80000, [1, 2, 3], 5, 3.5).severity).toBe("INFO");
    const comps = [70000, 75000, 80000, 82000, 85000, 90000];
    expect(priceOutlier(81000, comps, 5, 3.5).passed).toBe(true);
    expect(priceOutlier(500000, comps, 5, 3.5)).toMatchObject({ passed: false, severity: "SOFT" });
    expect(priceOutlier(1000, comps, 5, 3.5).passed).toBe(false);
    expect(priceOutlier(80000, [80000, 80000, 80000, 80000, 80000], 5, 3.5).passed).toBe(true); // MAD 0 handled
  });

  it("BLOCKING_CHECKLIST: a blocking bad answer is HARD", () => {
    expect(failed(stage1(ctx({}, { checklistAnswers: { cracks: "NO", worn: "YES" } })), "BLOCKING_CHECKLIST")[0]).toMatchObject({ severity: "HARD", fixStep: "condition" });
    expect(failed(stage1(ctx({}, { checklistAnswers: { cracks: "YES", worn: "NO" } })), "BLOCKING_CHECKLIST")).toEqual([]);
  });

  it("CONTACT_DETAILS: SOFT (masked, not blocked)", () => {
    expect(failed(stage1(ctx({}, { description: "Call 98765 43210" })), "CONTACT_DETAILS")[0]?.severity).toBe("SOFT");
  });
});

describe("Stage 2 vision rules", () => {
  const v = (over: Partial<VisionPhotoResult> = {}): VisionPhotoResult => ({
    photoId: "p1",
    index: 1,
    category: { categorySlug: "brake-pads", confidence: 0.99, modelVersion: "m" },
    damage: { damage: [], confidence: 0.9, modelVersion: "m" },
    ocr: { text: [], confidence: 0, modelVersion: "m" },
    ...over,
  });

  it("CATEGORY_MISMATCH counts only at or above the confidence threshold, with that confidence", () => {
    expect(failed(stage2(ctx(), [v({ category: { categorySlug: "mirrors", confidence: 0.7, modelVersion: "m" } })]), "CATEGORY_MISMATCH")).toEqual([]);
    expect(failed(stage2(ctx(), [v({ category: { categorySlug: "mirrors", confidence: 0.9, modelVersion: "m" } })]), "CATEGORY_MISMATCH")[0]).toMatchObject({ severity: "SOFT", confidence: 0.9 });
  });

  it("DAMAGE_CONTRADICTION fires only when the checklist reports no faults", () => {
    const damaged = v({ damage: { damage: [{ kind: "CRACK", score: 0.92 }], confidence: 0.92, modelVersion: "m" } });
    expect(failed(stage2(ctx(), [damaged]), "DAMAGE_CONTRADICTION")[0]).toMatchObject({ confidence: 0.92 });
    expect(failed(stage2(ctx({}, { checklistAnswers: { cracks: "YES", worn: "NO" } }), [damaged]), "DAMAGE_CONTRADICTION")).toEqual([]);
  });

  it("PART_NUMBER_OCR: differing number is SOFT; a match is a passed signal; nothing read is INFO", () => {
    expect(failed(stage2(ctx(), [v({ ocr: { text: ["OTHER-9999"], confidence: 0.95, modelVersion: "m" } })]), "PART_NUMBER_OCR")[0]?.severity).toBe("SOFT");
    const match = stage2(ctx(), [v({ ocr: { text: ["sample brk 0001"], confidence: 0.95, modelVersion: "m" } })]).find((c) => c.code === "PART_NUMBER_OCR");
    expect(match).toMatchObject({ passed: true });
    expect(stage2(ctx(), [v()]).find((c) => c.code === "PART_NUMBER_OCR")?.severity).toBe("INFO");
  });

  it("the development mock vision provider is deterministic and neutral for unknown images", async () => {
    const known = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" };
    const mock = createMockVisionProvider({ [imageHash(known)]: { category: { categorySlug: "mirrors", confidence: 0.97, modelVersion: "mock-vision-1" } } });
    expect(await mock.classifyCategory(known)).toEqual(await mock.classifyCategory(known));
    const unknown = { bytes: new Uint8Array([9, 9]), contentType: "image/jpeg" };
    const results: VisionPhotoResult = { photoId: "p1", index: 1, category: await mock.classifyCategory(unknown), damage: await mock.detectDamage(unknown), ocr: await mock.ocr(unknown) };
    expect(stage2(ctx(), [results]).filter((c) => !c.passed)).toEqual([]);
  });
});

describe("Stage 3: score, inspection requirement, trust label, routing", () => {
  it("score = min(100, Σ weight × confidence of failed SOFT checks)", () => {
    const soft = (code: string, confidence = 1): CheckResult => ({ code, passed: false, severity: "SOFT", confidence, message: "" });
    expect(riskScore([soft("CONTACT_DETAILS"), soft("DAMAGE_CONTRADICTION", 0.5)], settings.risk.weights)).toBe(35);
    expect(riskScore([{ ...soft("CONTACT_DETAILS"), passed: true }, { ...soft("BLUR"), severity: "HARD" }], settings.risk.weights)).toBe(0);
    expect(riskScore(["CATEGORY_MISMATCH", "DAMAGE_CONTRADICTION", "PART_NUMBER_OCR", "PRICE_OUTLIER", "CONTACT_DETAILS"].map((c) => soft(c)), settings.risk.weights)).toBe(100);
  });

  it("inspection requirement follows the §6.2 table", () => {
    const c = (inspectionTier: "A_AUTOMATED" | "B_CONDITIONAL" | "C_ALWAYS", optionalCheckEnabled = true) => ({ inspectionTier, inspectionValueThreshold: 500000, optionalCheckEnabled });
    expect(inspectionRequirement(c("C_ALWAYS"), 100, 0, settings)).toEqual({ requirement: "REQUIRED", reason: "TIER_C" });
    expect(inspectionRequirement(c("B_CONDITIONAL"), 500000, 0, settings)).toEqual({ requirement: "REQUIRED", reason: "TIER_B_THRESHOLD" });
    expect(inspectionRequirement(c("B_CONDITIONAL"), 499999, settings.inspections.riskThresholdTierB, settings)).toEqual({ requirement: "REQUIRED", reason: "HIGH_RISK" });
    expect(inspectionRequirement(c("B_CONDITIONAL"), 499999, settings.inspections.riskThresholdTierB - 1, settings)).toEqual({ requirement: "OPTIONAL", reason: null });
    expect(inspectionRequirement(c("A_AUTOMATED"), 999999, 99, settings)).toEqual({ requirement: "OPTIONAL", reason: null });
    expect(inspectionRequirement(c("A_AUTOMATED", false), 999999, 99, settings)).toEqual({ requirement: "NOT_NEEDED", reason: null });
  });

  it("trust label: SCREENED only with no hard failure and a score below lowRiskThreshold", () => {
    expect(trustLabel(false, settings.risk.lowRiskThreshold - 1, settings)).toBe("SCREENED");
    expect(trustLabel(false, settings.risk.lowRiskThreshold, settings)).toBe("SELLER_DECLARED");
    expect(trustLabel(true, 0, settings)).toBe("SELLER_DECLARED");
  });

  it("routing: any HARD failure → CHANGES_REQUESTED; otherwise LIVE, and SOFT flags or a high score go to admin review (D-5)", () => {
    const cat = { inspectionTier: "A_AUTOMATED" as const, inspectionValueThreshold: null, optionalCheckEnabled: false };
    const hard: CheckResult = { code: "BLUR", passed: false, severity: "HARD", confidence: 1, message: "blurry" };
    const soft: CheckResult = { code: "CONTACT_DETAILS", passed: false, severity: "SOFT", confidence: 1, message: "masked" };
    expect(route([hard, soft], cat, 1000, settings)).toMatchObject({ decision: "CHANGES_REQUESTED", hadHardFailure: true, requirement: null, needsAdminReview: false });
    expect(route([], cat, 1000, settings)).toMatchObject({ decision: "LIVE", requirement: "NOT_NEEDED", trustLabel: "SCREENED", needsAdminReview: false });
    expect(route([soft], cat, 1000, settings)).toMatchObject({ decision: "LIVE", needsAdminReview: true, reviewReasons: ["masked"] });
    const heavy = ["CATEGORY_MISMATCH", "DAMAGE_CONTRADICTION"].map((code): CheckResult => ({ ...soft, code, message: code }));
    expect(route(heavy, cat, 1000, settings).reviewReasons[0]).toMatch(/Risk score 65 is at or above 60/);
  });
});

describe("audit sampling (PLAN.md §6.3), applied at order time", () => {
  it("is deterministic for an order and settings version", () => {
    expect(selectedForAudit("order-1", 3, 5)).toBe(selectedForAudit("order-1", 3, 5));
  });

  it("selects about the configured percentage, none at 0% and all at 100%", () => {
    const ids = Array.from({ length: 20000 }, (_, i) => `order-${i}`);
    const rate = ids.filter((id) => selectedForAudit(id, 1, settings.inspections.auditPercent)).length / ids.length;
    expect(rate).toBeGreaterThan(0.04);
    expect(rate).toBeLessThan(0.06);
    expect(ids.slice(0, 500).some((id) => selectedForAudit(id, 1, 0))).toBe(false);
    expect(ids.slice(0, 500).every((id) => selectedForAudit(id, 1, 100))).toBe(true);
  });
});

describe("contact masking", () => {
  it("masks phones, emails, UPI handles and links; leaves other text", () => {
    expect(maskContactDetails("Call +91 98765 43210, mail a.b@example.com, pay x@okaxis, see www.example.com/p. Part SAMPLE-BRK-0001, 12,000 km.")).toBe(
      "Call [contact details hidden], mail [contact details hidden], pay [contact details hidden], see [contact details hidden] Part SAMPLE-BRK-0001, 12,000 km.",
    );
  });
});

describe("trust wording (PLAN.md §6.2)", () => {
  it('UI text never says "certified", "guaranteed" or "verified quality"', () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const f = join(dir, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.tsx?$/.test(n)) files.push(f);
      }
    };
    ["app", "src/components", "src/lib"].forEach((d) => walk(join(root, d)));
    const hits = files.filter((f) => /\b(certified|guaranteed|verified quality)\b/i.test(readFileSync(f, "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")));
    expect(hits).toEqual([]);
  });
});

vi.mock("@/server/auth/current", () => ({ getCurrentUser: vi.fn(async () => null), clientIp: vi.fn(async () => "127.0.0.1") }));

describe("check-status route", () => {
  it("returns 401 when signed out", async () => {
    const { GET } = await import("../../app/api/listings/[id]/check-status/route");
    expect((await GET(new Request("http://x"), { params: Promise.resolve({ id: "abc" }) })).status).toBe(401);
  }, 30_000); // first import loads the whole services layer (sharp, storage clients)
});
