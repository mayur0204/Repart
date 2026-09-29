import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, settingsSchema } from "@/server/services/settings/schema";
import { diffSettings } from "@/server/services/settings/settings";

const clone = () => structuredClone(DEFAULT_SETTINGS);

describe("settings schema", () => {
  it("covers every PLAN.md §6.5 group, including rate limits and signed-URL TTL", () => {
    const s = settingsSchema.parse(DEFAULT_SETTINGS);
    expect(Object.keys(s).sort()).toEqual(["fees", "grading", "inspections", "orders", "rateLimits", "risk", "storage"]);
    expect(s.rateLimits.otpVerifyAttempts.points).toBeGreaterThan(0);
    expect(s.storage.signedUrlTtlSeconds).toBe(600);
  });

  it("rejects thresholds that are out of order", () => {
    const risk = clone();
    risk.risk.adminReviewThreshold = risk.risk.lowRiskThreshold;
    expect(settingsSchema.safeParse(risk).error?.issues[0]?.path).toEqual(["risk", "adminReviewThreshold"]);

    const grading = clone();
    grading.grading.goodMin = 95;
    expect(settingsSchema.safeParse(grading).success).toBe(false);

    const brightness = clone();
    brightness.risk.minBrightness = 230;
    expect(settingsSchema.safeParse(brightness).success).toBe(false);
  });

  it("rejects out-of-range values and missing groups", () => {
    expect(settingsSchema.safeParse({ ...clone(), fees: { platformFeeBps: 10_001 } }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...clone(), risk: { ...clone().risk, minPhotos: 2 } }).success).toBe(false);
    const withoutRateLimits: Partial<typeof DEFAULT_SETTINGS> = clone();
    delete withoutRateLimits.rateLimits;
    expect(settingsSchema.safeParse(withoutRateLimits).success).toBe(false);
  });
});

describe("diffSettings", () => {
  it("returns dotted leaf paths for changed values only", () => {
    const next = clone();
    next.fees.platformFeeBps = 250;
    next.risk.weights.PRICE_OUTLIER = 30;
    expect(diffSettings(DEFAULT_SETTINGS, next)).toEqual([
      { path: "fees.platformFeeBps", before: 0, after: 250 },
      { path: "risk.weights.PRICE_OUTLIER", before: 20, after: 30 },
    ]);
    expect(diffSettings(DEFAULT_SETTINGS, clone())).toEqual([]);
  });

  it("compares arrays as whole values and reports added keys", () => {
    const next = clone();
    next.orders.buyerCancellationRules = next.orders.buyerCancellationRules.slice(0, 1);
    const changes = diffSettings(DEFAULT_SETTINGS, next);
    expect(changes.map((c) => c.path)).toEqual(["orders.buyerCancellationRules"]);
    expect(diffSettings({ a: 1 }, { a: 1, b: 2 })).toEqual([{ path: "b", before: undefined, after: 2 }]);
  });
});
