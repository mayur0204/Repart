import { z } from "zod";

/**
 * Admin-editable, versioned settings (PLAN.md §6.5). Each saved version is validated
 * with this schema; the version number is the risk-check `ruleSetVersion`.
 * Values below are development defaults; brief-given defaults are noted.
 */

const hours = z.number().int().positive();
const percent = z.number().min(0).max(100);
const score = z.number().int().min(0).max(100);

export const settingsSchema = z.object({
  fees: z.object({
    platformFeeBps: z.number().int().min(0).max(10_000), // brief §5: default 0
  }),
  orders: z.object({
    paymentTtlMinutes: z.number().int().positive(), // [assumption A-20]
    sellerConfirmHours: hours, // brief §7: default 24
    acceptanceWindowHours: hours, // brief §7: default 48
    providerMaxHoldDays: z.number().int().positive(), // brief §3: 45 (verify at M8, A-9)
    disputeDeadlineWarningDays: z.number().int().positive(), // brief §3: 7
    buyerCancellationRules: z
      .array(
        z.object({
          beforeState: z.string(),
          refundItem: z.boolean(),
          refundShipping: z.boolean(),
          refundCheck: z.boolean(),
        }),
      )
      .min(1), // [assumption A-5]
  }),
  inspections: z.object({
    auditPercent: percent, // brief §6: default 5
    riskThresholdTierB: score,
    partnerCheckLabelDays: z.number().int().positive(), // [assumption A-18]
  }),
  risk: z.object({
    lowRiskThreshold: score, // below this → "Screened by RePart"
    adminReviewThreshold: score,
    minPhotos: z.number().int().min(3), // brief §6: at least 3
    minPhotoShortSidePx: z.number().int().positive(),
    blurThreshold: z.number().positive(),
    minBrightness: z.number().min(0).max(255),
    maxBrightness: z.number().min(0).max(255),
    phashMaxDistance: z.number().int().min(0).max(64),
    minComparables: z.number().int().positive(),
    priceOutlierZ: z.number().positive(),
    materialPriceChangePercent: percent, // [assumption A-15]
    weights: z.record(z.string(), z.number().min(0).max(100)),
  }),
  grading: z.object({
    // [assumption A-17] score = 100 − Σ weights of "bad" answers
    likeNewMin: score,
    goodMin: score,
    fairMin: score,
  }),
  storage: z.object({
    signedUrlTtlSeconds: z.number().int().positive(),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  fees: { platformFeeBps: 0 },
  orders: {
    paymentTtlMinutes: 15,
    sellerConfirmHours: 24,
    acceptanceWindowHours: 48,
    providerMaxHoldDays: 45,
    disputeDeadlineWarningDays: 7,
    buyerCancellationRules: [
      { beforeState: "INSPECTION_PASSED", refundItem: true, refundShipping: true, refundCheck: true },
      { beforeState: "IN_TRANSIT", refundItem: true, refundShipping: true, refundCheck: false },
    ],
  },
  inspections: { auditPercent: 5, riskThresholdTierB: 60, partnerCheckLabelDays: 30 },
  risk: {
    lowRiskThreshold: 25,
    adminReviewThreshold: 60,
    minPhotos: 3,
    minPhotoShortSidePx: 800,
    blurThreshold: 100,
    minBrightness: 40,
    maxBrightness: 225,
    phashMaxDistance: 6,
    minComparables: 5,
    priceOutlierZ: 3.5,
    materialPriceChangePercent: 20,
    weights: {
      PRICE_OUTLIER: 20,
      CONTACT_DETAILS: 15,
      DUPLICATE_PHOTO_OWN: 10,
      CATEGORY_MISMATCH: 25,
      DAMAGE_CONTRADICTION: 40,
      PART_NUMBER_OCR: 20,
    },
  },
  grading: { likeNewMin: 90, goodMin: 70, fairMin: 40 },
  storage: { signedUrlTtlSeconds: 600 },
};
