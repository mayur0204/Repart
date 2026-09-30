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

export type TimelineStep = { state: string; label: string; status: "done" | "current" | "upcoming"; at: Date | null };

/**
 * The buyer/seller vertical timeline (PLAN.md §4.5): this order's happy path (Partner Check and delivery vs
 * local pickup), marked done / current / upcoming from its events. An off-path end state (cancelled,
 * disputed, resolved) is appended as the current step.
 */
export function orderTimeline(o: { state: string; inspection: boolean; delivery: boolean; events: Array<{ toState: string; createdAt: Date }> }): TimelineStep[] {
  const path = [
    "CREATED",
    "PAID_HELD",
    "AWAITING_SELLER",
    ...(o.inspection ? ["INSPECTION_SCHEDULED", "INSPECTION_PASSED"] : []),
    ...(o.delivery ? ["PICKUP_SCHEDULED", "IN_TRANSIT", "DELIVERED"] : ["AWAITING_HANDOVER"]),
    "ACCEPTANCE_WINDOW",
    "COMPLETED",
  ];
  const reached = new Map<string, Date>();
  for (const e of o.events) if (!reached.has(e.toState)) reached.set(e.toState, e.createdAt);
  const onPath = path.includes(o.state);
  const steps: TimelineStep[] = path
    .filter((s) => onPath || reached.has(s))
    .map((s) => ({ state: s, label: ORDER_STATE_TEXT[s] ?? s, status: s === o.state ? "current" : reached.has(s) ? "done" : "upcoming", at: reached.get(s) ?? null }));
  if (!onPath) steps.push({ state: o.state, label: ORDER_STATE_TEXT[o.state] ?? o.state, status: "current", at: reached.get(o.state) ?? null });
  return steps;
}

export const SHIPMENT_TEXT: Record<string, string> = {
  QUOTED: "Pickup not booked yet",
  BOOKED: "Pickup booked",
  PICKUP_SCHEDULED: "Pickup booked",
  PICKED_UP: "Picked up",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  FAILED: "Delivery attempt failed",
  CANCELLED: "Pickup cancelled",
  RETURNED_TO_ORIGIN: "Returned to the seller",
};

export const RESTRICTION_TEXT: Record<string, string | null> = {
  NONE: null,
  FRAGILE: "Fragile: wrap it well and mark the box fragile.",
  OVERSIZE: "Oversize: use a strong box that fits the part without forcing it.",
  NOT_SHIPPABLE: "Can't be shipped: local pickup only.",
};

/** Whole hours left until a deadline (0 once passed). */
export const hoursLeft = (deadline: Date | null, now: Date) => (deadline ? Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 3_600_000)) : null);
