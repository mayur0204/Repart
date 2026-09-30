/** Plain-language order states (PLAN.md §5.2), shared by buyer, seller and admin pages. */
export const ORDER_STATE_TEXT: Record<string, string> = {
  CREATED: "Waiting for payment",
  PAID_HELD: "Paid, money held",
  AWAITING_SELLER: "Waiting for the seller",
  INSPECTION_SCHEDULED: "Partner Check booked",
  INSPECTION_PASSED: "Partner Check passed",
  PICKUP_SCHEDULED: "Pickup booked",
  IN_TRANSIT: "On the way",
  DELIVERED: "Delivered",
  AWAITING_HANDOVER: "Waiting for handover",
  ACCEPTANCE_WINDOW: "Check the part",
  COMPLETED: "Completed",
  DISPUTED: "Problem reported",
  RESOLVED_REFUND: "Refunded after review",
  RESOLVED_RELEASE: "Resolved, seller paid",
  CANCELLED: "Cancelled",
};

export const SETTLEMENT_TEXT: Record<string, string> = {
  NOT_APPLICABLE: "No seller payout",
  HELD: "Held until the buyer accepts",
  ELIGIBLE: "Released, settling on the seller's schedule",
  SETTLED: "Paid to the seller",
  REVERSED: "Returned to the buyer",
};

export const REFUND_TEXT: Record<string, string> = { REQUESTED: "Requested", PENDING: "Processing", SUCCESS: "Refunded", FAILED: "Failed" };
