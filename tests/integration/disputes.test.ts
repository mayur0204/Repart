import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { createMockPaymentProvider, signMockWebhook } from "../../src/server/adapters/payment/mock";
import type { PaymentProvider, RefundInput } from "../../src/server/adapters/payment/types";
import { createMockShippingProvider, signMockTracking } from "../../src/server/adapters/shipping/mock";
import { createMemoryStorageProvider } from "../../src/server/adapters/storage/memory";
import { FieldError, NotFoundError, UserError } from "../../src/server/http/errors";
import { payOrder, placeOrder } from "../../src/server/services/order/checkout";
import {
  acceptanceTimeout,
  acceptOrder,
  bookDisputeReturn,
  confirmEvidenceUpload,
  disputeForUser,
  holdDeadlineWatch,
  reportProblem,
  requestEvidenceUpload,
  reviewState,
  sellerRespond,
  submitReview,
} from "../../src/server/services/order/disputes";
import { confirmOrder, pickupSlots } from "../../src/server/services/order/fulfilment";
import { resolveDispute, sweepOrders } from "../../src/server/services/order/lifecycle";
import { receivePaymentWebhook } from "../../src/server/services/payment/payment-events";
import { processRefund } from "../../src/server/services/payment/refunds";
import { releaseSettlement } from "../../src/server/services/payment/settlement";
import { receiveTrackingWebhook } from "../../src/server/services/shipping/tracking";
import { noAuditVersion, removeSettingsFixtures } from "../setup/settings-fixtures";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const PAY_SECRET = "test-webhook-secret-0123456789";
const SHIP_SECRET = "ship-secret-0123456789";
const BUYER = "sample-user-buyer";
const BUYER2 = "sample-user-buyer-2";
const SELLER = "sample-user-seller";
const ADMIN = { userId: "sample-user-admin" };
const VARIANT = "sample-variant-roadster-200-abs"; // the buyer's primary garage vehicle in the seed
const shipping = createMockShippingProvider({ webhookSecret: SHIP_SECRET });
const storage = createMemoryStorageProvider();
const ddeps = { storage, bucket: "dispute-evidence", shipping };
const HOUR = 3_600_000;
let jpeg: Buffer;

const base = createMockPaymentProvider({ webhookSecret: PAY_SECRET, baseUrl: "http://x" });
const payment = {
  ...base,
  name: "fake",
  createOrder: vi.fn(async (i: Parameters<PaymentProvider["createOrder"]>[0]) => ({ providerOrderId: `cf_${i.orderId}`, status: "CREATED" as const, checkoutUrl: null, paymentSessionId: `s_${i.orderId}`, amount: i.amount })),
  refund: vi.fn(async (i: RefundInput) => ({ providerRefundId: `pr_${i.refundId}`, status: "PENDING" as const })),
  getRefund: vi.fn(async () => null),
  markSettlementEligible: vi.fn(async () => {}),
} as unknown as PaymentProvider & { refund: Mock<PaymentProvider["refund"]>; markSettlementEligible: Mock<PaymentProvider["markSettlementEligible"]> };

async function newListing(over: Record<string, unknown> = {}) {
  const s = await db.listing.findUniqueOrThrow({ where: { id: "sample-listing-live-tier-a" } });
  const { checklistAnswers, ...rest } = s;
  for (const k of ["id", "createdAt", "updatedAt"] as const) delete (rest as Partial<typeof s>)[k];
  const id = `test-dp-${randomUUID()}`;
  await db.listing.create({ data: { ...rest, id, status: "LIVE", version: 0, checklistAnswers: checklistAnswers ?? Prisma.JsonNull, ...over } as Prisma.ListingUncheckedCreateInput });
  await db.fitment.create({ data: { listingId: id, variantId: VARIANT, source: "SELLER_DECLARED" } });
  return id;
}

/** Real M8/M9 path: checkout → payment webhook → seller confirms → courier "delivered" → ACCEPTANCE_WINDOW. */
async function deliveredOrder(over: Record<string, unknown> = {}) {
  const listingId = await newListing(over);
  const { orderId } = await placeOrder(db, { shipping, payment }, { userId: BUYER }, { listingId, addressId: "sample-addr-buyer" });
  await db.order.update({ where: { id: orderId }, data: { settingsVersion: await noAuditVersion(db) } });
  await payOrder(db, { shipping, payment }, { userId: BUYER }, orderId, "http://x");
  const total = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalPaise;
  const pay = JSON.stringify({ providerEventId: `evt_${randomUUID()}`, type: "PAYMENT_SUCCESS", providerType: "TEST", orderId, providerPaymentId: `pay_${orderId}`, amount: total, currency: "INR" });
  await receivePaymentWebhook(db, payment, pay, signMockWebhook(PAY_SECRET, pay, Date.now()));
  await confirmOrder(db, { shipping }, { userId: SELLER }, orderId, { slot: pickupSlots(new Date())[0]!.id });
  const s = await db.shipment.findFirstOrThrow({ where: { orderId, direction: "FORWARD" } });
  const trk = JSON.stringify({ providerEventId: `trk_${randomUUID()}`, shipmentId: s.providerRef, status: "DELIVERED", at: new Date().toISOString() });
  expect((await receiveTrackingWebhook(db, shipping, trk, signMockTracking(SHIP_SECRET, trk, Date.now()))).status).toBe(200);
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  expect(o.state).toBe("ACCEPTANCE_WINDOW");
  return { orderId, listingId, order: o };
}

const state = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).state;
const fitmentOf = (listingId: string) => db.fitment.findFirstOrThrow({ where: { listingId, variantId: VARIANT } });
const outboxOfType = (type: string) => db.outboxJob.findMany({ where: { payload: { path: ["type"], equals: type } } });
const report = (orderId: string, reason = "NOT_AS_DESCRIBED") => reportProblem(db, { userId: BUYER }, orderId, { reason, description: "The bracket is cracked and one mounting tab is missing." });

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
  jpeg = await sharp({ create: { width: 48, height: 48, channels: 3, background: "#999999" } }).jpeg().toBuffer();
});
afterAll(async () => {
  await removeSettingsFixtures(db);
  await db.$disconnect();
});

describe("acceptance window (O18 / O19)", () => {
  it("delivery schedules the automatic-completion job at the end of the 48-hour window", async () => {
    const { orderId, order } = await deliveredOrder();
    const job = await db.outboxJob.findFirstOrThrow({ where: { queue: "orders", name: "acceptanceTimeout", payload: { equals: { orderId } } } });
    expect(job.runAt.getTime()).toBeGreaterThanOrEqual(order.acceptanceEndsAt!.getTime());
    expect(order.acceptanceEndsAt!.getTime() - Date.now()).toBeGreaterThan(47 * HOUR);
  });

  it("'Confirm it's OK' completes the order, queues the payout release, learns the fitment and prompts reviews", async () => {
    const { orderId, listingId } = await deliveredOrder();
    expect(await acceptOrder(db, { userId: BUYER }, orderId)).toEqual({ already: false });
    expect(await state(orderId)).toBe("COMPLETED");
    expect(await db.outboxJob.count({ where: { queue: "orders", name: "releaseSettlement", payload: { equals: { orderId } } } })).toBe(1);
    expect((await fitmentOf(listingId)).confirmationCount).toBe(1);
    expect((await outboxOfType("order.review_prompt")).filter((j) => (j.payload as { link: string }).link === `/orders/${orderId}/review`)).toHaveLength(2);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("SOLD");
    // The timer later does nothing, and fitment learning isn't repeated.
    expect(await acceptanceTimeout(db, orderId, new Date(Date.now() + 49 * HOUR))).toBe("not_due");
    expect(await acceptOrder(db, { userId: BUYER }, orderId)).toEqual({ already: true });
    expect((await fitmentOf(listingId)).confirmationCount).toBe(1);
    // M8 guards stay authoritative: the release goes through for the completed order.
    expect(await releaseSettlement(db, payment, orderId)).toBe("released");
  });

  it("the timeout completes an untouched order exactly once; not before the end; the sweep is a backup", async () => {
    const a = await deliveredOrder();
    expect(await acceptanceTimeout(db, a.orderId)).toBe("not_due");
    const later = new Date(Date.now() + 49 * HOUR);
    expect(await acceptanceTimeout(db, a.orderId, later)).toBe("completed");
    expect(await acceptanceTimeout(db, a.orderId, later)).toBe("not_due");
    expect(await db.orderEvent.count({ where: { orderId: a.orderId, toState: "COMPLETED" } })).toBe(1);
    expect((await fitmentOf(a.listingId)).confirmationCount).toBe(1);

    const b = await deliveredOrder();
    expect((await sweepOrders(db, payment, later)).completed).toBeGreaterThanOrEqual(1);
    expect(await state(b.orderId)).toBe("COMPLETED");
  });

  it("after the window: confirming or reporting is refused; a disputed order is not completed by the timer", async () => {
    const late = await deliveredOrder();
    const after = new Date(Date.now() + 49 * HOUR);
    await expect(acceptOrder(db, { userId: BUYER }, late.orderId, after)).rejects.toThrow(/ended/);
    await expect(reportProblem(db, { userId: BUYER }, late.orderId, { reason: "OTHER", description: "It stopped working after two days of use." }, after)).rejects.toThrow(/ended/);

    const disputed = await deliveredOrder();
    await report(disputed.orderId);
    expect(await acceptanceTimeout(db, disputed.orderId, after)).toBe("not_due");
    expect(await state(disputed.orderId)).toBe("DISPUTED");
  });

  it("with no primary garage vehicle, fitment learning is skipped safely", async () => {
    const { orderId, listingId } = await deliveredOrder();
    await db.garageVehicle.updateMany({ where: { userId: BUYER }, data: { isPrimary: false } });
    try {
      await acceptOrder(db, { userId: BUYER }, orderId);
      expect(await state(orderId)).toBe("COMPLETED");
      expect((await fitmentOf(listingId)).confirmationCount).toBe(0);
    } finally {
      await db.garageVehicle.update({ where: { id: "sample-garage-buyer-roadster" }, data: { isPrimary: true } });
    }
  });
});

describe("report a problem (O20)", () => {
  it("the buyer reports: DISPUTED, dispute awaiting the seller, seller and admins told; only once", async () => {
    const { orderId } = await deliveredOrder();
    const disputeId = await report(orderId);
    expect(await state(orderId)).toBe("DISPUTED");
    expect(await db.dispute.findUniqueOrThrow({ where: { id: disputeId } })).toMatchObject({ status: "AWAITING_SELLER", reason: "NOT_AS_DESCRIBED" });
    const opened = (await outboxOfType("dispute.opened")).map((j) => j.payload as { userId: string; link: string });
    expect(opened.some((p) => p.userId === SELLER && p.link === `/orders/${orderId}/dispute`)).toBe(true);
    expect(opened.some((p) => p.userId === ADMIN.userId && p.link === `/admin/disputes/${disputeId}`)).toBe(true);
    await expect(report(orderId)).rejects.toBeInstanceOf(UserError);
    expect(await db.dispute.count({ where: { orderId } })).toBe(1);
  });

  it("only the buyer can report, and the description needs 20 characters", async () => {
    const { orderId } = await deliveredOrder();
    await expect(reportProblem(db, { userId: SELLER }, orderId, { reason: "OTHER", description: "x".repeat(30) })).rejects.toBeInstanceOf(NotFoundError);
    await expect(reportProblem(db, { userId: BUYER2 }, orderId, { reason: "OTHER", description: "x".repeat(30) })).rejects.toBeInstanceOf(NotFoundError);
    await expect(reportProblem(db, { userId: BUYER }, orderId, { reason: "OTHER", description: "too short" })).rejects.toBeInstanceOf(FieldError);
    await expect(reportProblem(db, { userId: BUYER }, orderId, { reason: "BROKEN", description: "x".repeat(30) })).rejects.toBeInstanceOf(FieldError);
    expect(await state(orderId)).toBe("ACCEPTANCE_WINDOW");
  });

  it("DOES_NOT_FIT flags the fitment path into the review queue", async () => {
    const { orderId, listingId } = await deliveredOrder();
    await report(orderId, "DOES_NOT_FIT");
    expect(await fitmentOf(listingId)).toMatchObject({ flaggedCount: 1, inReviewQueue: true, confirmationCount: 0 });
  });

  it("photos are optional, at most 5 per side, private, EXIF-stripped and shown through short-lived signed URLs", async () => {
    const { orderId } = await deliveredOrder();
    const disputeId = await report(orderId);
    expect((await disputeForUser(db, ddeps, BUYER, orderId)).evidence).toHaveLength(0);
    for (let i = 0; i < 5; i++) {
      const { evidenceId } = await requestEvidenceUpload(db, ddeps, { userId: BUYER }, { disputeId, size: jpeg.length, type: "image/jpeg" });
      const row = await db.disputeEvidence.findUniqueOrThrow({ where: { id: evidenceId } });
      await storage.put("dispute-evidence", row.incomingKey!, new Uint8Array(jpeg), "image/jpeg");
      expect(await confirmEvidenceUpload(db, ddeps, { userId: BUYER }, evidenceId)).toBe("ready");
    }
    await expect(requestEvidenceUpload(db, ddeps, { userId: BUYER }, { disputeId, size: jpeg.length, type: "image/jpeg" })).rejects.toThrow(/up to 5/);
    const view = await disputeForUser(db, ddeps, BUYER, orderId);
    expect(view.evidence).toHaveLength(5);
    for (const e of view.evidence) expect(e.url).toMatch(/^memory:\/\/download\/dispute-evidence\/disputes\/.+\?ttl=600$/);
    await expect(disputeForUser(db, ddeps, BUYER2, orderId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requestEvidenceUpload(db, ddeps, { userId: BUYER2 }, { disputeId, size: 10, type: "image/jpeg" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("seller response", () => {
  it("the seller responds with evidence within 48 hours; admins are told; the buyer can't respond for them", async () => {
    const { orderId } = await deliveredOrder();
    const disputeId = await report(orderId);
    await expect(sellerRespond(db, { userId: BUYER }, orderId, { response: "Not me, I am the buyer here." })).rejects.toBeInstanceOf(NotFoundError);
    const { evidenceId } = await requestEvidenceUpload(db, ddeps, { userId: SELLER }, { disputeId, size: jpeg.length, type: "image/jpeg" });
    const row = await db.disputeEvidence.findUniqueOrThrow({ where: { id: evidenceId } });
    await storage.put("dispute-evidence", row.incomingKey!, new Uint8Array(jpeg), "image/jpeg");
    await confirmEvidenceUpload(db, ddeps, { userId: SELLER }, evidenceId);
    await sellerRespond(db, { userId: SELLER }, orderId, { response: "The part was intact when packed; see the photo." });
    expect(await db.dispute.findUniqueOrThrow({ where: { id: disputeId } })).toMatchObject({ status: "UNDER_REVIEW", sellerResponse: "The part was intact when packed; see the photo." });
    expect((await outboxOfType("dispute.seller_responded")).some((j) => (j.payload as { link: string }).link === `/admin/disputes/${disputeId}`)).toBe(true);
    const sellerView = await disputeForUser(db, ddeps, SELLER, orderId);
    expect(sellerView.evidence.map((e) => e.party)).toEqual(["SELLER"]);
    await expect(sellerRespond(db, { userId: SELLER }, orderId, { response: "Second thoughts on this one." })).rejects.toBeInstanceOf(UserError);
  });

  it("after the deadline the seller can't respond or add photos, and nothing resolves automatically", async () => {
    const { orderId } = await deliveredOrder();
    const disputeId = await report(orderId);
    const late = new Date(Date.now() + 49 * HOUR);
    await expect(sellerRespond(db, { userId: SELLER }, orderId, { response: "Sorry, I was travelling all week." }, late)).rejects.toThrow(/ended/);
    await expect(requestEvidenceUpload(db, ddeps, { userId: SELLER }, { disputeId, size: jpeg.length, type: "image/jpeg" }, late)).rejects.toThrow(/ended/);
    await sweepOrders(db, payment, late);
    expect(await state(orderId)).toBe("DISPUTED");
    expect((await db.dispute.findUniqueOrThrow({ where: { id: disputeId } })).status).toBe("AWAITING_SELLER");
  });
});

describe("admin resolution (O21 / O22) and payout safety", () => {
  it("an open dispute blocks the seller's payout", async () => {
    const { orderId } = await deliveredOrder();
    await report(orderId);
    expect(await releaseSettlement(db, payment, orderId)).toBe("blocked");
    expect(payment.markSettlementEligible).not.toHaveBeenCalledWith(expect.objectContaining({ orderId }));
  });

  it("a reason is required; full refund: RESOLVED_REFUND, listing withdrawn, split reversed, courier return booked once", async () => {
    const { orderId, listingId, order } = await deliveredOrder();
    const disputeId = await report(orderId);
    await expect(resolveDispute(db, ADMIN, orderId, { decision: "REFUND", reason: "" })).rejects.toBeInstanceOf(FieldError);
    await resolveDispute(db, ADMIN, orderId, { decision: "REFUND", reason: "Photos show a crack the listing didn't mention" });
    expect(await state(orderId)).toBe("RESOLVED_REFUND");
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("WITHDRAWN");
    const refund = await db.refund.findFirstOrThrow({ where: { payment: { orderId } } });
    expect(refund).toMatchObject({ amountPaise: order.totalPaise, withSplitReversal: true, afterSettlement: false, idempotencyKey: `refund:${orderId}:dispute` });
    expect(await db.dispute.findUniqueOrThrow({ where: { id: disputeId } })).toMatchObject({ status: "RESOLVED_REFUND", refundAmountPaise: order.totalPaise, resolvedById: ADMIN.userId });
    expect(await bookDisputeReturn(db, ddeps, orderId)).toBe("booked");
    expect(await bookDisputeReturn(db, ddeps, orderId)).toBe("exists");
    const ret = await db.shipment.findFirstOrThrow({ where: { orderId, direction: "RETURN" } });
    expect((await db.dispute.findUniqueOrThrow({ where: { id: disputeId } })).returnShipmentId).toBe(ret.id);
    // Retry-safe refund with the stored idempotency key (existing M8 behaviour).
    await processRefund(db, payment, refund.id);
    await processRefund(db, payment, refund.id);
    const calls = payment.refund.mock.calls.filter((c) => c[0].refundId === refund.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ idempotencyKey: `refund:${orderId}:dispute`, vendorPortion: order.vendorSharePaise });
  });

  it("partial refund; after settlement RePart funds it and a seller recovery is opened; NOT_RECEIVED books no return", async () => {
    const { orderId, order } = await deliveredOrder();
    await reportProblem(db, { userId: BUYER }, orderId, { reason: "NOT_RECEIVED", description: "The courier marked it delivered but nothing arrived." });
    await db.payment.update({ where: { orderId }, data: { vendorSettlementStatus: "SETTLED" } }); // e.g. provider auto-release happened
    await resolveDispute(db, ADMIN, orderId, { decision: "REFUND", reason: "Partial refund agreed", item: String(Math.floor(order.itemPricePaise / 2)), shipping: "0", check: "0" });
    const refund = await db.refund.findFirstOrThrow({ where: { payment: { orderId } } });
    expect(refund.amountPaise).toBeLessThan(order.totalPaise);
    expect(refund).toMatchObject({ afterSettlement: true, withSplitReversal: false });
    expect(await db.sellerRecovery.findUniqueOrThrow({ where: { refundId: refund.id } })).toMatchObject({ status: "OPEN", amountPaise: refund.vendorPortionPaise });
    expect(await bookDisputeReturn(db, ddeps, orderId)).toBe("not_applicable");
  });

  it("release: RESOLVED_RELEASE, listing SOLD, payout release queued and allowed by the M8 guards", async () => {
    const { orderId, listingId } = await deliveredOrder();
    await report(orderId);
    await resolveDispute(db, ADMIN, orderId, { decision: "RELEASE", reason: "The part matches the listing photos" });
    expect(await state(orderId)).toBe("RESOLVED_RELEASE");
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("SOLD");
    expect(await db.outboxJob.count({ where: { queue: "orders", name: "releaseSettlement", payload: { equals: { orderId } } } })).toBe(1);
    expect(await releaseSettlement(db, payment, orderId)).toBe("released");
  });
});

describe("hold-deadline watch (PLAN §5.3)", () => {
  it("alerts every admin once per threshold (7d, 3d, 1d, 12h); reruns don't resend; the breach still works", async () => {
    const { orderId } = await deliveredOrder();
    await report(orderId);
    const now = new Date();
    const at = (hoursLeft: number) => new Date(now.getTime() + hoursLeft * HOUR);
    const sentFor = async () => (await db.auditLog.findMany({ where: { entityId: orderId, action: "order.hold_deadline_alert" } })).map((a) => (a.after as { threshold: string }).threshold);
    await db.order.update({ where: { id: orderId }, data: { autoReleaseAt: at(6 * 24) } });
    await holdDeadlineWatch(db, now);
    await holdDeadlineWatch(db, now);
    expect(await sentFor()).toEqual(["7d"]);
    for (const [hours, key] of [[60, "3d"], [20, "1d"], [10, "12h"]] as const) {
      await db.order.update({ where: { id: orderId }, data: { autoReleaseAt: at(hours) } });
      await holdDeadlineWatch(db, now);
      await holdDeadlineWatch(db, now);
      expect((await sentFor()).filter((k) => k === key)).toHaveLength(1);
    }
    expect(await sentFor()).toEqual(["7d", "3d", "1d", "12h"]);
    const alerts = (await outboxOfType("order.hold_deadline_alert")).filter((j) => (j.payload as { link: string }).link.startsWith("/admin/disputes/"));
    expect(alerts.length).toBeGreaterThanOrEqual(4);
    await db.order.update({ where: { id: orderId }, data: { autoReleaseAt: at(-1) } });
    await sweepOrders(db, payment);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).deadlineBreachedAt).not.toBeNull();
  });
});

describe("reviews", () => {
  it("only after COMPLETED, one per direction, rating 1–5, text optional", async () => {
    const { orderId } = await deliveredOrder();
    await expect(submitReview(db, { userId: BUYER }, orderId, { rating: "5" })).rejects.toThrow(/completed/);
    await acceptOrder(db, { userId: BUYER }, orderId);
    await expect(submitReview(db, { userId: BUYER }, orderId, { rating: "6" })).rejects.toBeInstanceOf(FieldError);
    await expect(submitReview(db, { userId: BUYER }, orderId, { rating: "" })).rejects.toBeInstanceOf(FieldError);
    await submitReview(db, { userId: BUYER }, orderId, { rating: "5", text: "Exactly as described, quick pickup." });
    await submitReview(db, { userId: SELLER }, orderId, { rating: "4" });
    await expect(submitReview(db, { userId: BUYER }, orderId, { rating: "1" })).rejects.toThrow(/already reviewed/);
    await expect(submitReview(db, { userId: BUYER2 }, orderId, { rating: "3" })).rejects.toBeInstanceOf(NotFoundError);
    const reviews = await db.review.findMany({ where: { orderId }, orderBy: { direction: "asc" } });
    expect(reviews.map((r) => [r.direction, r.authorId, r.subjectId, r.rating, r.text])).toEqual([
      ["BUYER_TO_SELLER", BUYER, SELLER, 5, "Exactly as described, quick pickup."],
      ["SELLER_TO_BUYER", SELLER, BUYER, 4, null],
    ]);
    expect((await reviewState(db, SELLER, orderId)).canReview).toBe(false);
  });
});
