import { Badge } from "@/components/ui/display";

/**
 * Trust label and inspection requirement wording (REPART_BRIEF.md §6 Stage 3, §10 "explain every trust label in one sentence").
 * Never "certified", "guaranteed" or "verified quality" (tests/unit/risk-rules.test.ts scans for these).
 */
export const TRUST_TEXT = {
  PARTNER_CHECK: { label: "Partner Check", tone: "fit", sentence: "A RePart partner mechanic inspected this part. Visual and basic check." },
  SCREENED: { label: "Screened by RePart", tone: "neutral", sentence: "Our automated checks of the photos and details found nothing unusual." },
  SELLER_DECLARED: { label: "Seller-declared", tone: "caution", sentence: "The details come from the seller and haven't been independently checked." },
} as const;

export const INSPECTION_TEXT = {
  REQUIRED: "A Partner Check is included before this part is shipped.",
  OPTIONAL: "Buyers can add an optional Partner Check at checkout.",
  NOT_NEEDED: "No Partner Check is needed for this kind of part.",
} as const;

export const INSPECTION_REASON_TEXT = {
  TIER_C: "Always checked: safety-critical kind of part.",
  TIER_B_THRESHOLD: "Checked because of the price.",
  HIGH_RISK: "Checked because our automated checks flagged something to look at.",
  BUYER_OPTIONAL: "Chosen by the buyer.",
  AUDIT: "Picked for a routine quality check.",
} as const;

export function TrustBadge({ label }: { label: keyof typeof TRUST_TEXT }) {
  const t = TRUST_TEXT[label];
  return <Badge tone={t.tone}>{t.label}</Badge>;
}
