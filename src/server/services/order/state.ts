import "server-only";
import type { ActorType, OrderState, Prisma } from "@/generated/prisma/client";
import { UserError } from "../../http/errors";
import { recordAudit } from "../audit/audit";
import { transitionListing } from "../listing/state";
import { enqueueOutbox } from "../outbox/outbox";

/**
 * The only writer of Order.state (PLAN.md §5.2). O1 `create` is the checkout service inserting the row;
 * every later change goes through transitionOrder. Money side effects (refunds, settlement release) are
 * started by the callers that know the amounts; this service owns state, the listing link, events,
 * audit and notifications.
 */
export type OrderEventName =
  | "paymentSucceeded" // O2
  | "paymentFailed" // O3
  | "paymentExpired" // O3
  | "notifySeller" // O4
  | "sellerConfirmedInspection" // O5
  | "sellerConfirmedDelivery" // O6
  | "sellerConfirmedPickup" // O7
  | "sellerTimeout" // O8
  | "sellerDeclined" // O9
  | "inspectionPassed" // O10
  | "inspectionFailed" // O11
  | "pickupBooked" // O12
  | "handoverArranged" // O13
  | "pickedUp" // O14
  | "delivered" // O15
  | "openAcceptanceWindow" // O16
  | "buyerConfirmedHandover" // O17
  | "buyerAccepted" // O18
  | "acceptanceTimeout" // O19
  | "problemReported" // O20
  | "resolveRefund" // O21
  | "resolveRelease" // O22
  | "buyerCancelled" // O23
  | "adminCancelled" // O24
  | "deliveryFailed"; // O25

export const TERMINAL_STATES: OrderState[] = ["COMPLETED", "RESOLVED_REFUND", "RESOLVED_RELEASE", "CANCELLED"];
/** States in which the buyer's money has been captured and not yet finally settled or refunded. */
export const PAID_OPEN_STATES: OrderState[] = [
  "PAID_HELD", "AWAITING_SELLER", "INSPECTION_SCHEDULED", "INSPECTION_PASSED", "PICKUP_SCHEDULED", "IN_TRANSIT", "DELIVERED", "AWAITING_HANDOVER", "ACCEPTANCE_WINDOW", "DISPUTED",
];

export const ORDER_TRANSITIONS: Record<OrderEventName, { from: OrderState[]; to: OrderState }> = {
  paymentSucceeded: { from: ["CREATED"], to: "PAID_HELD" },
  paymentFailed: { from: ["CREATED"], to: "CANCELLED" },
  paymentExpired: { from: ["CREATED"], to: "CANCELLED" },
  notifySeller: { from: ["PAID_HELD"], to: "AWAITING_SELLER" },
  sellerConfirmedInspection: { from: ["AWAITING_SELLER"], to: "INSPECTION_SCHEDULED" },
  sellerConfirmedDelivery: { from: ["AWAITING_SELLER"], to: "PICKUP_SCHEDULED" },
  sellerConfirmedPickup: { from: ["AWAITING_SELLER"], to: "AWAITING_HANDOVER" },
  sellerTimeout: { from: ["AWAITING_SELLER"], to: "CANCELLED" },
  sellerDeclined: { from: ["AWAITING_SELLER"], to: "CANCELLED" },
  inspectionPassed: { from: ["INSPECTION_SCHEDULED"], to: "INSPECTION_PASSED" },
  inspectionFailed: { from: ["INSPECTION_SCHEDULED"], to: "CANCELLED" },
  pickupBooked: { from: ["INSPECTION_PASSED"], to: "PICKUP_SCHEDULED" },
  handoverArranged: { from: ["INSPECTION_PASSED"], to: "AWAITING_HANDOVER" },
  pickedUp: { from: ["PICKUP_SCHEDULED"], to: "IN_TRANSIT" },
  delivered: { from: ["IN_TRANSIT"], to: "DELIVERED" },
  openAcceptanceWindow: { from: ["DELIVERED"], to: "ACCEPTANCE_WINDOW" },
  buyerConfirmedHandover: { from: ["AWAITING_HANDOVER"], to: "ACCEPTANCE_WINDOW" },
  buyerAccepted: { from: ["ACCEPTANCE_WINDOW"], to: "COMPLETED" },
  acceptanceTimeout: { from: ["ACCEPTANCE_WINDOW"], to: "COMPLETED" },
  problemReported: { from: ["ACCEPTANCE_WINDOW"], to: "DISPUTED" },
  resolveRefund: { from: ["DISPUTED"], to: "RESOLVED_REFUND" },
  resolveRelease: { from: ["DISPUTED"], to: "RESOLVED_RELEASE" },
  buyerCancelled: { from: ["PAID_HELD", "AWAITING_SELLER", "INSPECTION_SCHEDULED", "INSPECTION_PASSED", "PICKUP_SCHEDULED", "AWAITING_HANDOVER"], to: "CANCELLED" },
  adminCancelled: { from: PAID_OPEN_STATES, to: "CANCELLED" },
  deliveryFailed: { from: ["IN_TRANSIT"], to: "CANCELLED" },
};

export const canTransitionOrder = (state: OrderState, event: OrderEventName) => ORDER_TRANSITIONS[event].from.includes(state);

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Who hears about what (templated per target state; PLAN.md §5.2 "Every transition: notification"). */
const NOTICES: Partial<Record<OrderState, { to: "buyer" | "seller" | "both"; title: string; body: string }>> = {
  AWAITING_SELLER: { to: "both", title: "Payment received", body: "The payment for this order is confirmed and held safely until the buyer accepts the part." },
  CANCELLED: { to: "both", title: "Order cancelled", body: "This order was cancelled. Any payment taken will be refunded." },
  // M9 fulfilment steps
  INSPECTION_SCHEDULED: { to: "buyer", title: "Seller confirmed", body: "The seller confirmed the part is available. RePart is arranging the Partner Check." },
  PICKUP_SCHEDULED: { to: "both", title: "Pickup booked", body: "The courier pickup is booked. Pack the part using the packaging guide before the pickup slot." },
  AWAITING_HANDOVER: { to: "both", title: "Ready for handover", body: "Agree a time and place in Messages. The buyer confirms the handover in the order page." },
  IN_TRANSIT: { to: "both", title: "Part picked up", body: "The courier has picked up the part and it is on its way." },
  ACCEPTANCE_WINDOW: { to: "both", title: "Part received", body: "The buyer has the part. The acceptance window for checking it has started." },
  COMPLETED: { to: "both", title: "Order completed", body: "The buyer accepted the part. The seller's payout is being released." },
  DISPUTED: { to: "both", title: "Problem reported", body: "A problem was reported with this order. RePart will review it." },
  RESOLVED_REFUND: { to: "both", title: "Dispute resolved: refund", body: "The dispute was resolved with a refund to the buyer." },
  RESOLVED_RELEASE: { to: "both", title: "Dispute resolved: payout released", body: "The dispute was resolved and the seller's payout is being released." },
};

export async function transitionOrder(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    event: OrderEventName;
    actor: { type: ActorType; id: string | null };
    requestId?: string;
    reason?: string;
    payload?: Prisma.InputJsonObject;
    /** Extra order fields written in the same update (deadlines etc.). */
    data?: Prisma.OrderUpdateManyMutationInput;
  },
): Promise<{ from: OrderState; to: OrderState }> {
  const rule = ORDER_TRANSITIONS[input.event];
  const order = await tx.order.findUnique({ where: { id: input.orderId }, select: { state: true, version: true, listingId: true, buyerId: true, sellerId: true } });
  if (!order) throw new UserError("That order doesn't exist.");
  if (!rule.from.includes(order.state)) {
    throw new UserError(`This order is ${order.state.toLowerCase().replace(/_/g, " ")}, so that can't happen now.`);
  }
  const now = new Date();
  const { count } = await tx.order.updateMany({
    where: { id: input.orderId, state: order.state, version: order.version },
    data: {
      ...input.data,
      state: rule.to,
      version: { increment: 1 },
      ...(rule.to === "CANCELLED" && input.reason ? { cancelReason: input.reason.slice(0, 500) } : {}),
      ...(rule.to === "COMPLETED" ? { completedAt: now } : {}),
    },
  });
  if (count === 0) throw new UserError("This order was changed at the same time somewhere else. Reload the page and try again.");

  const payload = { ...(input.payload ?? {}), ...(input.reason ? { reason: input.reason } : {}) };
  await tx.orderEvent.create({ data: { orderId: input.orderId, fromState: order.state, toState: rule.to, event: input.event, actorType: input.actor.type, actorId: input.actor.id, payload } });
  await recordAudit(tx, {
    actor: input.actor,
    action: `order.${snake(input.event)}`,
    entity: { type: "Order", id: input.orderId },
    before: { state: order.state },
    after: { state: rule.to, ...payload },
    requestId: input.requestId,
  });

  // Listing link (PLAN.md §5.1 L11/L13/L14): only while the listing is still reserved by this order.
  const listing = await tx.listing.findUnique({ where: { id: order.listingId }, select: { status: true } });
  if (listing?.status === "RESERVED") {
    const sys = { type: "SYSTEM" as const, id: null };
    if (rule.to === "COMPLETED" || rule.to === "RESOLVED_RELEASE") await transitionListing(tx, { listingId: order.listingId, event: "sold", actor: sys, requestId: input.requestId });
    else if (rule.to === "RESOLVED_REFUND") await transitionListing(tx, { listingId: order.listingId, event: "returnedAfterDispute", actor: sys, requestId: input.requestId });
    else if (rule.to === "CANCELLED") {
      await transitionListing(tx, { listingId: order.listingId, event: "release", actor: sys, requestId: input.requestId });
      // O9: declining implies the part isn't available any more [assumption in PLAN.md §5.2].
      if (input.event === "sellerDeclined") await transitionListing(tx, { listingId: order.listingId, event: "withdraw", actor: sys, requestId: input.requestId });
    }
  }

  // §7.2 step 6: release the held seller split once the sale stands (the job re-checks every rule).
  if (rule.to === "COMPLETED" || rule.to === "RESOLVED_RELEASE") {
    await enqueueOutbox(tx, { queue: "orders", name: "releaseSettlement", payload: { orderId: input.orderId } });
  }

  const notice = NOTICES[rule.to];
  if (notice) {
    const users = notice.to === "both" ? [order.buyerId, order.sellerId] : [notice.to === "buyer" ? order.buyerId : order.sellerId];
    for (const userId of users) {
      await enqueueOutbox(tx, { queue: "notifications", name: "send", payload: { userId, channel: "IN_APP", type: `order.${snake(input.event)}`, title: notice.title, body: notice.body, link: `/orders/${input.orderId}` } });
    }
  }
  return { from: order.state, to: rule.to };
}
