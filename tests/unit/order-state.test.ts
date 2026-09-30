import { describe, expect, it } from "vitest";
import { canTransitionOrder, ORDER_TRANSITIONS, TERMINAL_STATES, type OrderEventName } from "@/server/services/order/state";

// PLAN.md §5.2, row by row: event → [from states, to state].
const PLAN: Record<OrderEventName, [string[], string]> = {
  paymentSucceeded: [["CREATED"], "PAID_HELD"],
  paymentFailed: [["CREATED"], "CANCELLED"],
  paymentExpired: [["CREATED"], "CANCELLED"],
  notifySeller: [["PAID_HELD"], "AWAITING_SELLER"],
  sellerConfirmedInspection: [["AWAITING_SELLER"], "INSPECTION_SCHEDULED"],
  sellerConfirmedDelivery: [["AWAITING_SELLER"], "PICKUP_SCHEDULED"],
  sellerConfirmedPickup: [["AWAITING_SELLER"], "AWAITING_HANDOVER"],
  sellerTimeout: [["AWAITING_SELLER"], "CANCELLED"],
  sellerDeclined: [["AWAITING_SELLER"], "CANCELLED"],
  inspectionPassed: [["INSPECTION_SCHEDULED"], "INSPECTION_PASSED"],
  inspectionFailed: [["INSPECTION_SCHEDULED"], "CANCELLED"],
  pickupBooked: [["INSPECTION_PASSED"], "PICKUP_SCHEDULED"],
  handoverArranged: [["INSPECTION_PASSED"], "AWAITING_HANDOVER"],
  pickedUp: [["PICKUP_SCHEDULED"], "IN_TRANSIT"],
  delivered: [["IN_TRANSIT"], "DELIVERED"],
  openAcceptanceWindow: [["DELIVERED"], "ACCEPTANCE_WINDOW"],
  buyerConfirmedHandover: [["AWAITING_HANDOVER"], "ACCEPTANCE_WINDOW"],
  buyerAccepted: [["ACCEPTANCE_WINDOW"], "COMPLETED"],
  acceptanceTimeout: [["ACCEPTANCE_WINDOW"], "COMPLETED"],
  problemReported: [["ACCEPTANCE_WINDOW"], "DISPUTED"],
  resolveRefund: [["DISPUTED"], "RESOLVED_REFUND"],
  resolveRelease: [["DISPUTED"], "RESOLVED_RELEASE"],
  buyerCancelled: [["PAID_HELD", "AWAITING_SELLER", "INSPECTION_SCHEDULED", "INSPECTION_PASSED", "PICKUP_SCHEDULED", "AWAITING_HANDOVER"], "CANCELLED"],
  adminCancelled: [["PAID_HELD", "AWAITING_SELLER", "INSPECTION_SCHEDULED", "INSPECTION_PASSED", "PICKUP_SCHEDULED", "IN_TRANSIT", "DELIVERED", "AWAITING_HANDOVER", "ACCEPTANCE_WINDOW", "DISPUTED"], "CANCELLED"],
  deliveryFailed: [["IN_TRANSIT"], "CANCELLED"],
};
const ALL_STATES = ["CREATED", "PAID_HELD", "AWAITING_SELLER", "INSPECTION_SCHEDULED", "INSPECTION_PASSED", "PICKUP_SCHEDULED", "IN_TRANSIT", "DELIVERED", "AWAITING_HANDOVER", "ACCEPTANCE_WINDOW", "COMPLETED", "DISPUTED", "RESOLVED_REFUND", "RESOLVED_RELEASE", "CANCELLED"] as const;

describe("order state machine matches PLAN.md §5.2 exhaustively", () => {
  it("has exactly the planned events", () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual(Object.keys(PLAN).sort());
  });
  it.each(Object.entries(PLAN))("%s", (event, [from, to]) => {
    expect(ORDER_TRANSITIONS[event as OrderEventName].to).toBe(to);
    for (const s of ALL_STATES) expect(canTransitionOrder(s, event as OrderEventName)).toBe(from.includes(s));
  });
  it("terminal states have no way out, and money can't be marked paid twice", () => {
    for (const t of TERMINAL_STATES) for (const e of Object.keys(PLAN) as OrderEventName[]) expect(canTransitionOrder(t, e)).toBe(false);
    for (const s of ALL_STATES.filter((x) => x !== "CREATED")) expect(canTransitionOrder(s, "paymentSucceeded")).toBe(false);
  });
});
