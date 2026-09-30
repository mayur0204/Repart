/** Plain-language dispute wording shared by buyer, seller and admin pages (M11). */
export const DISPUTE_REASON_TEXT: Record<string, string> = {
  DOES_NOT_FIT: "Doesn't fit my bike",
  NOT_AS_DESCRIBED: "Not as described",
  DAMAGED_IN_TRANSIT: "Damaged in transit",
  NOT_RECEIVED: "Not received",
  OTHER: "Something else",
};

export const DISPUTE_STATUS_TEXT: Record<string, string> = {
  OPEN: "Reported",
  AWAITING_SELLER: "Waiting for the seller's response",
  UNDER_REVIEW: "RePart is reviewing",
  RESOLVED_REFUND: "Resolved: refund",
  RESOLVED_RELEASE: "Resolved: payout released to the seller",
};
