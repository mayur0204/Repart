import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { createMockPaymentProvider, signMockWebhook } from "../../src/server/adapters/payment/mock";
import type { PaymentProvider } from "../../src/server/adapters/payment/types";
import { createMockShippingProvider, signMockTracking } from "../../src/server/adapters/shipping/mock";
import { FieldError, NotFoundError, UserError } from "../../src/server/http/errors";
import { logger } from "../../src/server/logger";
import { payOrder, placeOrder } from "../../src/server/services/order/checkout";
import { adminConfirmReturn, afterInspectionPassed, buyerCancelOrder, buyerCancellationPreview, confirmHandover, confirmOrder, declineOrder, pickupSlots, schedulePickup } from "../../src/server/services/order/fulfilment";
import { orderForUser, sellerOrder, sellerOrders } from "../../src/server/services/order/read";
import { receivePaymentWebhook } from "../../src/server/services/payment/payment-events";
import { devAdvanceShipment, receiveTrackingWebhook } from "../../src/server/services/shipping/tracking";
import { noAuditVersion, removeSettingsFixtures } from "../setup/settings-fixtures";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const PAY_SECRET = "test-webhook-secret-0123456789";
const SHIP_SECRET = "test-shipping-secret-0123456789";
const BUYER = "sample-user-buyer";
const BUYER2 = "sample-user-buyer-2";
const SELLER = "sample-user-seller";
const ADMIN = { userId: "sample-user-admin" };
const shipping = createMockShippingProvider({ webhookSecret: SHIP_SECRET });
const payment = { ...createMockPaymentProvider({ webhookSecret: PAY_SECRET, baseUrl: "http://x" }), name: "fake" } as PaymentProvider;
const deps = { shipping, payment };

async function newListing(over: Record<string, unknown> = {}) {
  const src = await db.listing.findUniqueOrThrow({ where: { id: "sample-listing-live-tier-a" } });
  const { checklistAnswers, ...rest } = src;
  for (const k of ["id", "createdAt", "updatedAt"] as const) delete (rest as Partial<typeof src>)[k];
  const id = `test-ff-${randomUUID()}`;
  await db.listing.create({ data: { ...rest, id, status: "LIVE", version: 0, checklistAnswers: checklistAnswers ?? Prisma.JsonNull, ...over } as Prisma.ListingUncheckedCreateInput });
  return id;
}

/** A paid order waiting for the seller (M8 path: checkout → session → signed payment webhook). */
async function paidOrder(opts: { listing?: Record<string, unknown>; order?: Prisma.OrderUpdateInput } = {}) {
  const listingId = await newListing(opts.listing);
  const local = opts.listing?.fulfilmentMode === "LOCAL_PICKUP";
  const { orderId } = await placeOrder(db, deps, { userId: BUYER }, { listingId, addressId: local ? undefined : "sample-addr-buyer" });
  await db.order.update({ where: { id: orderId }, data: { settingsVersion: await noAuditVersion(db), ...opts.order } }); // deterministic: no M10 audit selection
  await payOrder(db, deps, { userId: BUYER }, orderId, "http://x");
  const total = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalPaise;
  const rawBody = JSON.stringify({ providerEventId: `evt_${randomUUID()}`, type: "PAYMENT_SUCCESS", providerType: "TEST", orderId, providerPaymentId: `pay_${randomUUID()}`, amount: total, currency: "INR" });
  expect((await receivePaymentWebhook(db, payment, rawBody, signMockWebhook(PAY_SECRET, rawBody, Date.now()))).status).toBe(200);
  expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).state).toBe("AWAITING_SELLER");
  return { orderId, listingId };
}

const firstSlot = (now = new Date()) => pickupSlots(now)[0]!.id;
const seller = { userId: SELLER };
const state = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).state;
const forward = (orderId: string) => db.shipment.findFirstOrThrow({ where: { orderId, direction: "FORWARD" }, include: { trackingEvents: true } });

async function track(orderId: string, status: string, opts: { eventId?: string; ts?: number; secret?: string } = {}) {
  const s = await forward(orderId);
  const rawBody = JSON.stringify({ providerEventId: opts.eventId ?? `trk_${randomUUID()}`, shipmentId: s.providerRef, status, at: new Date().toISOString(), location: "Hub" });
  return receiveTrackingWebhook(db, shipping, rawBody, signMockTracking(opts.secret ?? SHIP_SECRET, rawBody, opts.ts ?? Date.now()));
}

async function shipped() {
  const o = await paidOrder();
  await confirmOrder(db, deps, seller, o.orderId, { slot: firstSlot() });
  await track(o.orderId, "PICKED_UP");
  return o;
}

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
  // M10 books a garage for Partner Check orders; give the sample garage room so these M9 flows never hit its daily limit.
  await db.mechanicPartner.update({ where: { id: "sample-garage-partner" }, data: { capacityPerDay: 1000 } });
});
afterAll(async () => {
  await removeSettingsFixtures(db);
  await db.$disconnect();
});

describe("seller orders: access and countdown", () => {
  it("a seller sees only orders for their own listings; others get not-found", async () => {
    const { orderId } = await paidOrder();
    const mine = await sellerOrders(db, SELLER);
    expect(mine.toHandle.map((o) => o.id)).toContain(orderId);
    expect((await sellerOrders(db, "sample-user-seller-nopayout")).toHandle.map((o) => o.id)).not.toContain(orderId);
    await expect(sellerOrder(db, "sample-user-seller-nopayout", orderId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(sellerOrder(db, BUYER, orderId)).rejects.toBeInstanceOf(NotFoundError); // the buyer can't use the seller page
    await expect(orderForUser(db, BUYER2, orderId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(confirmOrder(db, deps, { userId: "sample-user-seller-nopayout" }, orderId, { slot: firstSlot() })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("shows the confirmation countdown and the pickup slots on offer", async () => {
    const { orderId } = await paidOrder();
    const o = await sellerOrder(db, SELLER, orderId);
    expect(o.sellerHoursLeft).toBe(24);
    expect(o.slots).toHaveLength(12);
    expect(o.listing.category?.packagingGuide).toBeTruthy();
  });
});

describe("seller confirmation", () => {
  it("delivery: confirm + slot books the courier, persists the shipment, and moves to PICKUP_SCHEDULED once", async () => {
    const { orderId } = await paidOrder();
    const book = vi.spyOn(shipping, "bookPickup");
    const before = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    const slot = pickupSlots(new Date())[2]!;
    expect(await confirmOrder(db, deps, seller, orderId, { slot: slot.id })).toEqual({ state: "PICKUP_SCHEDULED", already: false });
    expect(await confirmOrder(db, deps, seller, orderId, { slot: slot.id })).toEqual({ state: "PICKUP_SCHEDULED", already: true });
    expect(book).toHaveBeenCalledTimes(1);
    book.mockRestore();
    const s = await forward(orderId);
    expect(s).toMatchObject({ status: "PICKUP_SCHEDULED", provider: "mock", pickupSlotStart: slot.start, pickupSlotEnd: slot.end });
    expect(s.providerRef).toMatch(/^mock_ship_/);
    expect(s.awb).toMatch(/^MOCKAWB/);
    const after = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(after.state).toBe("PICKUP_SCHEDULED");
    expect(after.totalPaise).toBe(before.totalPaise); // the buyer is never charged again
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: s.id, action: "shipment.booked" } });
    expect(audit.after).toMatchObject({ buyerPaidPaise: before.shippingFeePaise, courierQuotePaise: s.quotedFeePaise });
  });

  it("a missing, made-up or expired slot is refused and nothing is booked", async () => {
    const { orderId } = await paidOrder();
    await expect(confirmOrder(db, deps, seller, orderId, {})).rejects.toBeInstanceOf(FieldError);
    await expect(confirmOrder(db, deps, seller, orderId, { slot: "2020-01-01T04:30:00.000Z" })).rejects.toBeInstanceOf(FieldError);
    await expect(confirmOrder(db, deps, seller, orderId, { slot: pickupSlots(new Date(Date.now() - 10 * 86_400_000))[0]!.id })).rejects.toBeInstanceOf(FieldError);
    expect(await state(orderId)).toBe("AWAITING_SELLER");
    expect(await db.shipment.count({ where: { orderId } })).toBe(0);
  });

  it("Partner Check: confirming moves to INSPECTION_SCHEDULED and keeps the preferred slot without booking", async () => {
    const { orderId } = await paidOrder({ order: { inspectionReason: "TIER_C" } });
    const slot = firstSlot();
    expect((await confirmOrder(db, deps, seller, orderId, { slot, inspectionSlot: slot })).state).toBe("INSPECTION_SCHEDULED");
    expect(await forward(orderId)).toMatchObject({ status: "QUOTED", providerRef: null, pickupSlotStart: new Date(slot) });
  });

  it("after a passed check: a still-valid slot is booked; a stale one asks the seller for a new slot", async () => {
    const fresh = await paidOrder({ order: { inspectionReason: "TIER_C" } });
    await confirmOrder(db, deps, seller, fresh.orderId, { slot: firstSlot(), inspectionSlot: firstSlot() });
    await db.order.update({ where: { id: fresh.orderId }, data: { state: "INSPECTION_PASSED" } });
    expect(await afterInspectionPassed(db, deps, fresh.orderId)).toBe("booked");
    expect(await state(fresh.orderId)).toBe("PICKUP_SCHEDULED");

    const stale = await paidOrder({ order: { inspectionReason: "TIER_C" } });
    await confirmOrder(db, deps, seller, stale.orderId, { slot: firstSlot(), inspectionSlot: firstSlot() });
    await db.order.update({ where: { id: stale.orderId }, data: { state: "INSPECTION_PASSED" } });
    const later = new Date(Date.now() + 10 * 86_400_000);
    expect(await afterInspectionPassed(db, deps, stale.orderId, later)).toBe("needs_slot");
    expect(await state(stale.orderId)).toBe("INSPECTION_PASSED");
    await expect(schedulePickup(db, deps, seller, stale.orderId, { slot: firstSlot() }, later)).rejects.toBeInstanceOf(FieldError); // the old offer is stale
    await schedulePickup(db, deps, seller, stale.orderId, { slot: firstSlot(later) }, later);
    expect(await state(stale.orderId)).toBe("PICKUP_SCHEDULED");
  });

  it("local pickup: no courier; AWAITING_HANDOVER with a masked M7 conversation; the buyer's handover opens the 48h window", async () => {
    const { orderId, listingId } = await paidOrder({ listing: { fulfilmentMode: "LOCAL_PICKUP" } });
    const book = vi.spyOn(shipping, "bookPickup");
    expect((await confirmOrder(db, deps, seller, orderId, {})).state).toBe("AWAITING_HANDOVER");
    expect(book).not.toHaveBeenCalled();
    book.mockRestore();
    expect(await db.conversation.count({ where: { listingId, buyerId: BUYER, sellerId: SELLER } })).toBe(1);
    expect((await orderForUser(db, BUYER, orderId)).conversationId).toBeTruthy();
    await expect(confirmHandover(db, { userId: BUYER2 }, orderId)).rejects.toBeInstanceOf(NotFoundError);
    const now = new Date();
    await confirmHandover(db, { userId: BUYER }, orderId, now);
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(o.state).toBe("ACCEPTANCE_WINDOW");
    expect(o.acceptanceEndsAt!.getTime() - now.getTime()).toBe(48 * 3_600_000);
    expect(await confirmHandover(db, { userId: BUYER }, orderId)).toEqual({ already: true });
  });

  it("decline: CANCELLED with a full refund through the M8 refund service; listing withdrawn; repeat is a no-op", async () => {
    const { orderId, listingId } = await paidOrder();
    await declineOrder(db, seller, orderId, { reason: "Sold it at my shop" });
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { events: { orderBy: { createdAt: "asc" } } } });
    expect(o.state).toBe("CANCELLED");
    expect(o.events.at(-1)).toMatchObject({ event: "sellerDeclined", actorType: "USER", actorId: SELLER });
    const refund = await db.refund.findFirstOrThrow({ where: { payment: { orderId } } });
    expect(refund).toMatchObject({ amountPaise: o.totalPaise, vendorPortionPaise: o.vendorSharePaise, merchantPortionPaise: o.merchantSharePaise, idempotencyKey: `refund:${orderId}:seller_declined` });
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("WITHDRAWN");
    expect(await db.auditLog.count({ where: { entityId: orderId, action: "order.seller_declined" } })).toBe(1);
    expect(await db.outboxJob.count({ where: { name: "send", payload: { path: ["type"], equals: "order.seller_declined" } } })).toBeGreaterThanOrEqual(2);
    expect(await declineOrder(db, seller, orderId, {})).toEqual({ already: true });
    expect(await db.refund.count({ where: { payment: { orderId } } })).toBe(1);
  });
});

describe("courier tracking webhooks", () => {
  it("picked up → IN_TRANSIT; out for delivery keeps it there; delivered → DELIVERED → ACCEPTANCE_WINDOW (48h)", async () => {
    const { orderId } = await paidOrder();
    await confirmOrder(db, deps, seller, orderId, { slot: firstSlot() });
    expect(await track(orderId, "PICKED_UP")).toEqual({ status: 200, outcome: "processed" });
    expect(await state(orderId)).toBe("IN_TRANSIT");
    await track(orderId, "IN_TRANSIT");
    await track(orderId, "OUT_FOR_DELIVERY");
    expect(await state(orderId)).toBe("IN_TRANSIT");
    expect((await forward(orderId)).status).toBe("OUT_FOR_DELIVERY");
    const before = Date.now();
    await track(orderId, "DELIVERED");
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { events: { orderBy: { createdAt: "asc" } } } });
    expect(o.state).toBe("ACCEPTANCE_WINDOW");
    expect(o.events.map((e) => e.toState).slice(-4)).toEqual(["PICKUP_SCHEDULED", "IN_TRANSIT", "DELIVERED", "ACCEPTANCE_WINDOW"]);
    expect(o.acceptanceEndsAt!.getTime() - before).toBeGreaterThanOrEqual(48 * 3_600_000 - 1000);
    const s = await forward(orderId);
    expect(s.status).toBe("DELIVERED");
    expect(s.trackingEvents).toHaveLength(4);
  });

  it("a delivered event without a pickup event still gets the order to ACCEPTANCE_WINDOW", async () => {
    const { orderId } = await paidOrder();
    await confirmOrder(db, deps, seller, orderId, { slot: firstSlot() });
    await track(orderId, "DELIVERED");
    expect(await state(orderId)).toBe("ACCEPTANCE_WINDOW");
  });

  it("forged, tampered and replayed webhooks are rejected before anything is stored; duplicates are applied once", async () => {
    const { orderId } = await shipped();
    const count = await db.trackingEvent.count();
    const warn = vi.spyOn(logger, "warn");
    const forged = await track(orderId, "DELIVERED", { secret: "wrong-secret-00000000000" });
    expect(forged.status).toBe(401);
    expect(JSON.stringify([forged, warn.mock.calls])).not.toContain(SHIP_SECRET); // nothing about the secret leaks
    warn.mockRestore();
    expect((await track(orderId, "DELIVERED", { ts: Date.now() - 6 * 60_000 })).status).toBe(401);
    const s = await forward(orderId);
    const rawBody = JSON.stringify({ providerEventId: "trk_tamper", shipmentId: s.providerRef, status: "OUT_FOR_DELIVERY", at: new Date().toISOString() });
    const headers = signMockTracking(SHIP_SECRET, rawBody, Date.now());
    expect((await receiveTrackingWebhook(db, shipping, rawBody.replace("OUT_FOR_DELIVERY", "DELIVERED"), headers)).status).toBe(401);
    expect(await db.trackingEvent.count()).toBe(count);
    expect(await state(orderId)).toBe("IN_TRANSIT");

    const id = `trk_dup_${orderId}`;
    expect((await track(orderId, "OUT_FOR_DELIVERY", { eventId: id })).outcome).toBe("processed");
    expect((await track(orderId, "OUT_FOR_DELIVERY", { eventId: id })).outcome).toBe("duplicate");
    expect(await db.trackingEvent.count({ where: { providerEventId: id } })).toBe(1);
  });

  it("an event for an unknown shipment is acknowledged and changes nothing", async () => {
    const rawBody = JSON.stringify({ providerEventId: "trk_x", shipmentId: "no_such_shipment", status: "DELIVERED", at: new Date().toISOString() });
    expect(await receiveTrackingWebhook(db, shipping, rawBody, signMockTracking(SHIP_SECRET, rawBody, Date.now()))).toEqual({ status: 200, outcome: "unknown_shipment" });
  });

  it("failed delivery is only flagged; the admin confirms the return → CANCELLED, full refund, listing LIVE", async () => {
    const { orderId, listingId } = await shipped();
    await track(orderId, "DELIVERY_FAILED");
    expect(await state(orderId)).toBe("IN_TRANSIT"); // no automatic O25
    expect((await forward(orderId)).status).toBe("FAILED");
    expect(await db.refund.count({ where: { payment: { orderId } } })).toBe(0);
    expect(await db.outboxJob.count({ where: { payload: { path: ["link"], equals: `/admin/orders/${orderId}` } } })).toBeGreaterThanOrEqual(1);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("RESERVED");

    await expect(adminConfirmReturn(db, ADMIN, orderId, { reason: "Courier says RTO" })).rejects.toBeInstanceOf(FieldError); // return not confirmed
    await track(orderId, "RETURNED");
    await adminConfirmReturn(db, ADMIN, orderId, { reason: "Seller confirmed the part is back", returned: "yes" });
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(o.state).toBe("CANCELLED");
    expect(await db.refund.findFirstOrThrow({ where: { payment: { orderId } } })).toMatchObject({ amountPaise: o.totalPaise, idempotencyKey: `refund:${orderId}:delivery_failed` });
    expect((await forward(orderId)).status).toBe("RETURNED_TO_ORIGIN");
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("LIVE");
    expect(await db.auditLog.count({ where: { entityId: orderId, action: "order.delivery_failed" } })).toBe(1);
    expect(await adminConfirmReturn(db, ADMIN, orderId, { reason: "again please", returned: "yes" })).toEqual({ already: true });
  });

  it("the admin can't close an order whose courier hasn't reported a problem", async () => {
    const { orderId } = await shipped();
    await expect(adminConfirmReturn(db, ADMIN, orderId, { reason: "No reason really", returned: "yes" })).rejects.toBeInstanceOf(UserError);
  });
});

describe("buyer cancellation and order page", () => {
  it("before the seller confirms: full refund per the rules; the listing goes LIVE", async () => {
    const { orderId, listingId } = await paidOrder();
    const preview = await buyerCancellationPreview(db, BUYER, orderId);
    await buyerCancelOrder(db, deps, { userId: BUYER }, orderId, {});
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(o.state).toBe("CANCELLED");
    const refund = await db.refund.findFirstOrThrow({ where: { payment: { orderId } } });
    expect(refund.amountPaise).toBe(o.totalPaise);
    expect(refund.components).toEqual(preview);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("LIVE");
    expect(await buyerCancelOrder(db, deps, { userId: BUYER }, orderId, {})).toEqual({ already: true });
  });

  it("after a passed Partner Check the check fee isn't refunded, per the default rules", async () => {
    const listingId = await newListing();
    const order = await db.order.create({
      data: {
        buyerId: BUYER, sellerId: SELLER, listingId, fulfilmentMode: "DELIVERY", pickupAddress: { pincode: "999901" }, deliveryAddress: { pincode: "999902" }, settingsVersion: 1, idempotencyKey: `k_${randomUUID()}`, state: "CREATED", inspectionReason: "TIER_C",
        itemPricePaise: 1_000_000, shippingFeePaise: 30_000, checkFeePaise: 20_000, platformFeePaise: 30_000, platformFeeBps: 300, vendorSharePaise: 970_000, merchantSharePaise: 80_000, totalPaise: 1_050_000,
      },
    });
    await db.listing.update({ where: { id: listingId }, data: { status: "RESERVED" } });
    await payOrder(db, deps, { userId: BUYER }, order.id, "http://x");
    const rawBody = JSON.stringify({ providerEventId: `evt_${randomUUID()}`, type: "PAYMENT_SUCCESS", providerType: "TEST", orderId: order.id, providerPaymentId: "p1", amount: 1_050_000, currency: "INR" });
    await receivePaymentWebhook(db, payment, rawBody, signMockWebhook(PAY_SECRET, rawBody, Date.now()));
    await db.order.update({ where: { id: order.id }, data: { state: "INSPECTION_PASSED" } });
    expect(await buyerCancellationPreview(db, BUYER, order.id)).toEqual({ item: 1_000_000, shipping: 30_000, check: 0 });
    await buyerCancelOrder(db, deps, { userId: BUYER }, order.id, { reason: "Changed my mind" });
    // §7.5 allocation: ₹10,000 item (₹9,700 back from the seller split + ₹300 fee share) + ₹300 delivery; ₹200 check kept.
    expect(await db.refund.findFirstOrThrow({ where: { payment: { orderId: order.id } } })).toMatchObject({ amountPaise: 1_030_000, vendorPortionPaise: 970_000, merchantPortionPaise: 60_000 });
  });

  it("with a booked pickup: the courier booking is cancelled too; after pickup the buyer can't cancel", async () => {
    const booked = await paidOrder();
    await confirmOrder(db, deps, seller, booked.orderId, { slot: firstSlot() });
    const cancel = vi.spyOn(shipping, "cancel");
    await buyerCancelOrder(db, deps, { userId: BUYER }, booked.orderId, {});
    expect(cancel).toHaveBeenCalledWith((await forward(booked.orderId)).providerRef);
    cancel.mockRestore();
    expect((await forward(booked.orderId)).status).toBe("CANCELLED");
    expect(await state(booked.orderId)).toBe("CANCELLED");

    const moving = await shipped();
    expect(await buyerCancellationPreview(db, BUYER, moving.orderId)).toBeNull();
    await expect(buyerCancelOrder(db, deps, { userId: BUYER }, moving.orderId, {})).rejects.toBeInstanceOf(UserError);
    await expect(buyerCancelOrder(db, deps, { userId: BUYER2 }, moving.orderId, {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the buyer's order page shows the timeline and tracking", async () => {
    const { orderId } = await shipped();
    const o = await orderForUser(db, BUYER, orderId);
    expect(o.timeline.find((s) => s.status === "current")!.state).toBe("IN_TRANSIT");
    expect(o.timeline.filter((s) => s.status === "done").map((s) => s.state)).toEqual(["CREATED", "PAID_HELD", "AWAITING_SELLER", "PICKUP_SCHEDULED"]);
    expect(o.shipment).toMatchObject({ status: "PICKED_UP" });
    expect(o.shipment!.trackingEvents.map((e) => e.description)).toEqual(["Picked up from the seller"]);
    expect(o.cancelRefund).toBeNull();
  });
});

describe("end to end: seller confirms → pickup booked → mock courier advances → delivered", () => {
  it("runs through the dev advance tool and the real webhook handler", async () => {
    const { orderId } = await paidOrder();
    await confirmOrder(db, deps, seller, orderId, { slot: firstSlot() });
    for (const status of ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"] as const) {
      expect((await devAdvanceShipment(db, shipping, SHIP_SECRET, orderId, status)).status).toBe(200);
    }
    const o = await orderForUser(db, BUYER, orderId);
    expect(o.state).toBe("ACCEPTANCE_WINDOW");
    expect(o.acceptanceHoursLeft).toBe(48);
    expect(o.shipment!.trackingEvents).toHaveLength(4);
    expect(o.timeline.find((s) => s.status === "current")!.state).toBe("ACCEPTANCE_WINDOW");
  });
});
