import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type ShipmentStatus } from "@/generated/prisma/client";
import { signMockTracking } from "../../adapters/shipping/mock";
import type { ShippingProvider, TrackingEvent } from "../../adapters/shipping/types";
import { NotFoundError } from "../../http/errors";
import { logger } from "../../logger";
import { recordAudit } from "../audit/audit";
import { transitionOrder } from "../order/state";
import { enqueueOutbox } from "../outbox/outbox";
import { getSettingsVersion } from "../settings/settings";

/**
 * Courier tracking webhooks (PLAN.md §4.9, §5.2 O14–O16, O25). Same security as the payment webhooks:
 * signature over timestamp + raw body, a replay window, and one row per courier event id
 * (TrackingEvent is unique on shipment + event id), so a duplicate delivery changes nothing.
 * A failed or returned delivery is only flagged; an admin confirms the return (O25).
 */
type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
const HOUR_MS = 3_600_000;
const COURIER = { type: "PROVIDER_WEBHOOK" as const, id: null };

const TO_SHIPMENT: Record<TrackingEvent["status"], ShipmentStatus> = {
  BOOKED: "BOOKED",
  PICKED_UP: "PICKED_UP",
  IN_TRANSIT: "IN_TRANSIT",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  DELIVERY_FAILED: "FAILED",
  RETURNED: "RETURNED_TO_ORIGIN",
  CANCELLED: "CANCELLED",
};
/** Shipment status only moves forward; a late or out-of-order event is recorded but doesn't move it back. */
const RANK: Record<ShipmentStatus, number> = { QUOTED: 0, BOOKED: 1, PICKUP_SCHEDULED: 2, PICKED_UP: 3, IN_TRANSIT: 4, OUT_FOR_DELIVERY: 5, FAILED: 6, DELIVERED: 7, RETURNED_TO_ORIGIN: 8, CANCELLED: 9 };
const DESCRIPTION: Record<TrackingEvent["status"], string> = {
  BOOKED: "Pickup booked",
  PICKED_UP: "Picked up from the seller",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  DELIVERY_FAILED: "Delivery attempt failed",
  RETURNED: "Returned to the seller",
  CANCELLED: "Pickup cancelled",
};

export type TrackingResult = { status: number; outcome: "processed" | "duplicate" | "rejected" | "invalid" | "unknown_shipment" | "failed" };

export async function receiveTrackingWebhook(db: Db, shipping: ShippingProvider, rawBody: string, headers: Headers, now = new Date()): Promise<TrackingResult> {
  if (!shipping.verifyWebhook(rawBody, headers, now)) {
    logger.warn({ provider: shipping.name }, "tracking webhook rejected: bad signature or stale timestamp");
    return { status: 401, outcome: "rejected" };
  }
  let event: TrackingEvent;
  try {
    event = shipping.parseTracking(rawBody);
    if (!event.providerEventId || !event.shipmentId || !TO_SHIPMENT[event.status] || Number.isNaN(event.at.getTime())) throw new Error("bad event");
  } catch {
    return { status: 400, outcome: "invalid" };
  }
  try {
    return await db.$transaction(async (tx) => {
      const shipment = await tx.shipment.findUnique({ where: { providerRef: event.shipmentId }, select: { id: true, orderId: true, status: true, direction: true } });
      if (!shipment) return { status: 200, outcome: "unknown_shipment" as const }; // acknowledged so the courier stops retrying; nothing to change
      await tx.trackingEvent.create({
        data: { shipmentId: shipment.id, providerEventId: event.providerEventId, status: TO_SHIPMENT[event.status], description: DESCRIPTION[event.status], location: event.location?.slice(0, 200), occurredAt: event.at },
      });
      await applyTracking(tx, shipment, event, now);
      return { status: 200, outcome: "processed" as const };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { status: 200, outcome: "duplicate" };
    logger.error({ provider: shipping.name, eventId: event.providerEventId, err: (err as Error).message }, "tracking webhook processing failed");
    return { status: 500, outcome: "failed" }; // the courier retries; processing is idempotent
  }
}

async function applyTracking(tx: Tx, shipment: { id: string; orderId: string; status: ShipmentStatus; direction: string }, event: TrackingEvent, now: Date) {
  const next = TO_SHIPMENT[event.status];
  if (RANK[next] > RANK[shipment.status]) await tx.shipment.update({ where: { id: shipment.id }, data: { status: next } });
  if (shipment.direction !== "FORWARD") return; // return shipments (M11) don't drive the forward order states

  const order = await tx.order.findUniqueOrThrow({ where: { id: shipment.orderId }, select: { id: true, state: true, settingsVersion: true, buyerId: true } });
  const pickedUp = async () => {
    if (order.state === "PICKUP_SCHEDULED") {
      await transitionOrder(tx, { orderId: order.id, event: "pickedUp", actor: COURIER, payload: { trackingStatus: event.status } }); // O14
      order.state = "IN_TRANSIT";
    }
  };
  switch (event.status) {
    case "PICKED_UP":
    case "IN_TRANSIT":
    case "OUT_FOR_DELIVERY":
      await pickedUp();
      return;
    case "DELIVERED": {
      await pickedUp(); // a missed pickup event mustn't strand the order
      if (order.state !== "IN_TRANSIT") return;
      await transitionOrder(tx, { orderId: order.id, event: "delivered", actor: COURIER }); // O15
      const { settings } = await getSettingsVersion(tx, order.settingsVersion);
      await transitionOrder(tx, { orderId: order.id, event: "openAcceptanceWindow", actor: { type: "SYSTEM", id: null }, data: { acceptanceEndsAt: new Date(now.getTime() + settings.orders.acceptanceWindowHours * HOUR_MS) } }); // O16
      return;
    }
    case "DELIVERY_FAILED":
    case "RETURNED": {
      // Flag for an admin; O25 happens only when an admin confirms the part is back with the seller.
      await recordAudit(tx, { actor: COURIER, action: event.status === "RETURNED" ? "shipment.returned_reported" : "shipment.delivery_failed", entity: { type: "Shipment", id: shipment.id }, after: { orderId: order.id, eventId: event.providerEventId } });
      const admins = await tx.user.findMany({ where: { roles: { has: "ADMIN" }, status: "ACTIVE" }, select: { id: true } });
      const body = event.status === "RETURNED" ? "The courier reports the part was returned to the seller. Review and confirm the return." : "The courier reports a failed delivery attempt. Review the order.";
      for (const a of admins) {
        await enqueueOutbox(tx, { queue: "notifications", name: "send", payload: { userId: a.id, channel: "IN_APP", type: "shipment.needs_review", title: "Delivery problem", body, link: `/admin/orders/${order.id}` } });
      }
      await enqueueOutbox(tx, { queue: "notifications", name: "send", payload: { userId: order.buyerId, channel: "IN_APP", type: "shipment.delivery_problem", title: "Delivery problem", body: "The courier reported a problem delivering your part. RePart is looking into it.", link: `/orders/${order.id}` } });
      return;
    }
    default:
      return;
  }
}

export const DEV_TRACKING_STATUSES = ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED", "RETURNED"] as const;

/** Dev only (PLAN.md §1.3 "advance shipment"): a signed mock courier event through the same webhook handler. */
export async function devAdvanceShipment(db: Db, shipping: ShippingProvider, secret: string, orderId: string, status: (typeof DEV_TRACKING_STATUSES)[number]) {
  if (process.env.NODE_ENV === "production" || shipping.name !== "mock") throw new Error("advancing shipments is only available with the mock courier outside production");
  const shipment = await db.shipment.findFirst({ where: { orderId, direction: "FORWARD", providerRef: { not: null } }, orderBy: { createdAt: "desc" }, select: { providerRef: true } });
  if (!shipment?.providerRef) throw new NotFoundError("booked shipment");
  const rawBody = JSON.stringify({ providerEventId: `mock_trk_${randomUUID()}`, shipmentId: shipment.providerRef, status, at: new Date().toISOString(), location: "Mock hub" });
  return receiveTrackingWebhook(db, shipping, rawBody, signMockTracking(secret, rawBody, Date.now()));
}
