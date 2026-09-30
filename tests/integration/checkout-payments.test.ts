import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { createCashfreePaymentProvider } from "../../src/server/adapters/payment/cashfree";
import { CashfreeError, createCashfreeClient } from "../../src/server/adapters/payment/cashfree-client";
import { createMockPaymentProvider, signMockWebhook } from "../../src/server/adapters/payment/mock";
import type { PaymentProvider, PaymentWebhookEvent, ProviderPayment, RefundInput } from "../../src/server/adapters/payment/types";
import { createMockShippingProvider } from "../../src/server/adapters/shipping/mock";
import { NotFoundError, UserError } from "../../src/server/http/errors";
import { payOrder, placeOrder } from "../../src/server/services/order/checkout";
import { adminCancelOrder, adminRefundOnly, expirePayment, resolveDispute, sellerTimeout, sweepOrders } from "../../src/server/services/order/lifecycle";
import { orderForUser } from "../../src/server/services/order/read";
import { confirmFromProvider, receivePaymentWebhook } from "../../src/server/services/payment/payment-events";
import { runReconciliation } from "../../src/server/services/payment/reconciliation";
import { applyRefundStatus, processRefund } from "../../src/server/services/payment/refunds";
import { releaseSettlement, syncSettlement } from "../../src/server/services/payment/settlement";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const SECRET = "test-webhook-secret-0123456789";
const BUYER = "sample-user-buyer";
const BUYER2 = "sample-user-buyer-2";
const SELLER = "sample-user-seller";
const ADDR = "sample-addr-buyer";
const VENDOR = "sample-mock-vendor-seller";
const shipping = createMockShippingProvider({ webhookSecret: SECRET });

type SpiedKeys = "createOrder" | "getOrder" | "getPayments" | "refund" | "getRefund" | "markSettlementEligible" | "getOrderSettlement";
type FakeProvider = PaymentProvider & { [K in SpiedKeys]: Mock<PaymentProvider[K]> };

/** A recording provider with the mock's real webhook signing; every money call is a spy. */
function fakeProvider(over: Partial<PaymentProvider> = {}) {
  const base = createMockPaymentProvider({ webhookSecret: SECRET, baseUrl: "http://localhost:3000" });
  return {
    ...base,
    name: "fake",
    createOrder: vi.fn(async (i: Parameters<PaymentProvider["createOrder"]>[0]) => ({ providerOrderId: `cf_${i.orderId}`, status: "CREATED" as const, checkoutUrl: null, paymentSessionId: `session_${i.orderId}`, amount: i.amount })),
    getOrder: vi.fn(base.getOrder),
    getPayments: vi.fn(async (): Promise<ProviderPayment[]> => []),
    refund: vi.fn(async (i: RefundInput) => ({ providerRefundId: `pr_${i.refundId}`, status: "PENDING" as const })),
    getRefund: vi.fn(async () => null),
    markSettlementEligible: vi.fn(async () => {}),
    getOrderSettlement: vi.fn(async () => null),
    ...over,
  } as unknown as FakeProvider;
}
const deps = (payment: PaymentProvider) => ({ shipping, payment });

function signed(event: Partial<PaymentWebhookEvent> & { orderId: string }, ts = Date.now()) {
  const body: PaymentWebhookEvent = { providerEventId: `evt_${randomUUID()}`, type: "PAYMENT_SUCCESS", providerType: "TEST", currency: "INR", providerPaymentId: `pay_${randomUUID()}`, ...event };
  const rawBody = JSON.stringify(body);
  return { rawBody, headers: signMockWebhook(SECRET, rawBody, ts) };
}

async function newListing(over: Prisma.ListingUncheckedCreateInput | Record<string, unknown> = {}) {
  const src = await db.listing.findUniqueOrThrow({ where: { id: "sample-listing-live-tier-a" } });
  const { checklistAnswers, ...rest } = src;
  for (const k of ["id", "createdAt", "updatedAt"] as const) delete (rest as Partial<typeof src>)[k];
  const id = `test-cp-${randomUUID()}`;
  await db.listing.create({ data: { ...rest, id, status: "LIVE", version: 0, checklistAnswers: checklistAnswers ?? Prisma.JsonNull, ...over } as Prisma.ListingUncheckedCreateInput });
  return id;
}

async function createdOrder(p: PaymentProvider, buyer = BUYER) {
  const listingId = await newListing();
  const { orderId } = await placeOrder(db, deps(p), { userId: buyer }, { listingId, addressId: buyer === BUYER ? ADDR : "sample-addr-buyer-2" });
  await payOrder(db, deps(p), { userId: buyer }, orderId, "http://localhost:3000");
  return { orderId, listingId };
}

async function paidOrder(p: PaymentProvider) {
  const o = await createdOrder(p);
  const total = (await db.order.findUniqueOrThrow({ where: { id: o.orderId } })).totalPaise;
  const w = signed({ orderId: o.orderId, amount: total });
  expect((await receivePaymentWebhook(db, p, w.rawBody, w.headers)).status).toBe(200);
  return { ...o, total };
}

const mismatches = (orderId: string | null, kind: string) => db.reconciliationMismatch.count({ where: { orderId, kind } });

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
afterAll(async () => {
  await db.$disconnect();
});

describe("checkout: server-side money, one open order, idempotent session", () => {
  it("prices on the server, ignores amounts sent by the browser and reserves the listing", async () => {
    const p = fakeProvider();
    const listingId = await newListing();
    const { orderId } = await placeOrder(db, deps(p), { userId: BUYER }, { listingId, addressId: ADDR, totalPaise: 1, platformFeePaise: 0, vendorSharePaise: 999_999, itemPricePaise: 1 });
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    const listing = await db.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(o.itemPricePaise).toBe(listing.pricePaise);
    expect(o.shippingFeePaise).toBeGreaterThan(0); // mock courier quote, 999901 → 999902
    expect(o.totalPaise).toBe(o.itemPricePaise + o.shippingFeePaise + o.checkFeePaise);
    expect(o.vendorSharePaise).toBe(o.itemPricePaise - o.platformFeePaise);
    expect(o.state).toBe("CREATED");
    expect(listing.status).toBe("RESERVED");
    expect(await db.outboxJob.count({ where: { queue: "orders", name: "expirePayment", payload: { equals: { orderId } } } })).toBe(1);
  });

  it("a repeat checkout resumes the open order; another buyer can't reserve the same part", async () => {
    const p = fakeProvider();
    const listingId = await newListing();
    const a = await placeOrder(db, deps(p), { userId: BUYER }, { listingId, addressId: ADDR });
    const b = await placeOrder(db, deps(p), { userId: BUYER }, { listingId, addressId: ADDR });
    expect(b).toEqual({ orderId: a.orderId, resumed: true });
    await expect(placeOrder(db, deps(p), { userId: BUYER2 }, { listingId, addressId: "sample-addr-buyer-2" })).rejects.toThrow(/no longer available|buying this part/);
  });

  it("creates one provider order with the seller's split; paying again reuses the session", async () => {
    const p = fakeProvider();
    const { orderId } = await createdOrder(p);
    const again = await payOrder(db, deps(p), { userId: BUYER }, orderId, "http://localhost:3000");
    expect(again.paymentSessionId).toBe(`session_${orderId}`);
    expect(p.createOrder).toHaveBeenCalledTimes(1);
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(p.createOrder.mock.calls[0]![0]).toMatchObject({ orderId, amount: o.totalPaise, vendorId: VENDOR, vendorShare: o.vendorSharePaise, returnUrl: `http://localhost:3000/checkout/return?order=${orderId}` });
  });

  it("the brief's example order sends ₹10,500 with a ₹9,700 split to the seller's vendor", async () => {
    const p = fakeProvider();
    const listingId = await newListing();
    const order = await db.order.create({
      data: {
        buyerId: BUYER, sellerId: SELLER, listingId, fulfilmentMode: "DELIVERY", pickupAddress: {}, settingsVersion: 1, idempotencyKey: `k_${randomUUID()}`, state: "CREATED",
        itemPricePaise: 1_000_000, shippingFeePaise: 30_000, checkFeePaise: 20_000, platformFeePaise: 30_000, platformFeeBps: 300, vendorSharePaise: 970_000, merchantSharePaise: 80_000, totalPaise: 1_050_000,
      },
    });
    await payOrder(db, deps(p), { userId: BUYER }, order.id, "http://x");
    expect(p.createOrder.mock.calls[0]![0]).toMatchObject({ amount: 1_050_000, vendorShare: 970_000, vendorId: VENDOR });
  });

  it("no checkout while the seller's vendor isn't ACTIVE", async () => {
    const p = fakeProvider();
    const listingId = await newListing();
    for (const status of ["PENDING", "ACTION_REQUIRED", "BLOCKED"] as const) {
      await db.payoutAccount.update({ where: { userId: SELLER }, data: { status } });
      try {
        await expect(placeOrder(db, deps(p), { userId: BUYER }, { listingId, addressId: ADDR })).rejects.toThrow(/can't receive payments/);
      } finally {
        await db.payoutAccount.update({ where: { userId: SELLER }, data: { status: "ACTIVE" } });
      }
    }
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("LIVE");
  });

  it("another user can't see, pay or confirm someone else's order", async () => {
    const p = fakeProvider();
    const { orderId } = await createdOrder(p);
    await expect(orderForUser(db, BUYER2, orderId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(payOrder(db, deps(p), { userId: BUYER2 }, orderId, "http://x")).rejects.toBeInstanceOf(NotFoundError);
    expect((await orderForUser(db, SELLER, orderId)).role).toBe("seller");
  });
});

describe("payment results through the verified webhook", () => {
  it("success → PAID_HELD → AWAITING_SELLER with the 45-day hold deadline and seller timer", async () => {
    const p = fakeProvider();
    const { orderId } = await paidOrder(p);
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true, events: true } });
    expect(o.state).toBe("AWAITING_SELLER");
    expect(o.payment).toMatchObject({ status: "SUCCESS", vendorSettlementStatus: "HELD", vendorId: VENDOR });
    expect(o.autoReleaseAt!.getTime() - o.payment!.paidAt!.getTime()).toBe(45 * 86_400_000);
    expect(o.sellerConfirmBy).not.toBeNull();
    expect(o.events.map((e) => e.toState)).toEqual(["CREATED", "PAID_HELD", "AWAITING_SELLER"]);
    expect(await db.outboxJob.count({ where: { queue: "orders", name: "sellerTimeout", payload: { equals: { orderId } } } })).toBe(1);
  });

  it("failure and abandonment keep the order payable; a later retry succeeds", async () => {
    const p = fakeProvider();
    const { orderId } = await createdOrder(p);
    const total = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalPaise;
    for (const type of ["PAYMENT_FAILED", "PAYMENT_USER_DROPPED"] as const) {
      const w = signed({ orderId, type, amount: total });
      expect((await receivePaymentWebhook(db, p, w.rawBody, w.headers)).status).toBe(200);
    }
    let o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true } });
    expect(o.state).toBe("CREATED");
    expect(o.payment!.status).toBe("FAILED");
    expect((await payOrder(db, deps(p), { userId: BUYER }, orderId, "http://x")).paymentSessionId).toBe(`session_${orderId}`);
    const ok = signed({ orderId, amount: total });
    await receivePaymentWebhook(db, p, ok.rawBody, ok.headers);
    o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true } });
    expect(o.state).toBe("AWAITING_SELLER");
    expect(o.payment!.status).toBe("SUCCESS");
  });

  it("a wrong amount is flagged and never marks the order paid", async () => {
    const p = fakeProvider();
    const { orderId } = await createdOrder(p);
    const w = signed({ orderId, amount: 100 });
    expect((await receivePaymentWebhook(db, p, w.rawBody, w.headers)).status).toBe(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).state).toBe("CREATED");
    expect(await mismatches(orderId, "AMOUNT_MISMATCH")).toBe(1);
  });

  it("a second successful payment on the same order is flagged, not applied twice", async () => {
    const p = fakeProvider();
    const { orderId, total } = await paidOrder(p);
    const w = signed({ orderId, amount: total });
    await receivePaymentWebhook(db, p, w.rawBody, w.headers);
    expect(await mismatches(orderId, "DUPLICATE_PAYMENT")).toBe(1);
    expect(await db.orderEvent.count({ where: { orderId, toState: "PAID_HELD" } })).toBe(1);
  });

  it("an invalid signature or a stale timestamp is rejected before anything is stored", async () => {
    const p = fakeProvider();
    const { orderId } = await createdOrder(p);
    const w = signed({ orderId, amount: 1 });
    const forged = new Headers(w.headers);
    forged.set("x-mock-signature", "00".repeat(32));
    const before = await db.webhookEvent.count();
    expect((await receivePaymentWebhook(db, p, w.rawBody, forged)).status).toBe(401);
    const stale = signed({ orderId, amount: 1 }, Date.now() - 10 * 60_000);
    expect((await receivePaymentWebhook(db, p, stale.rawBody, stale.headers)).status).toBe(401);
    expect(await db.webhookEvent.count()).toBe(before);
  });

  it("a duplicate delivery (same event id) is acknowledged once and applied once", async () => {
    const p = fakeProvider();
    const { orderId } = await createdOrder(p);
    const total = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalPaise;
    const w = signed({ orderId, amount: total, providerEventId: `evt_dup_${orderId}` });
    expect(await receivePaymentWebhook(db, p, w.rawBody, w.headers)).toEqual({ status: 200, outcome: "processed" });
    const again = signed({ orderId, amount: total, providerEventId: `evt_dup_${orderId}` });
    expect(await receivePaymentWebhook(db, p, again.rawBody, again.headers)).toEqual({ status: 200, outcome: "duplicate" });
    expect(await db.paymentEvent.count({ where: { providerEventId: `evt_dup_${orderId}` } })).toBe(1);
  });

  it("unknown events are stored and acknowledged but change nothing; unknown orders are flagged", async () => {
    const p = fakeProvider();
    const { orderId } = await createdOrder(p);
    const u = signed({ orderId, type: "UNKNOWN", providerType: "PAYMENT_CHARGES_WEBHOOK" });
    expect((await receivePaymentWebhook(db, p, u.rawBody, u.headers)).status).toBe(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).state).toBe("CREATED");
    const ghost = `ghost_${randomUUID()}`;
    const g = signed({ orderId: ghost, amount: 100 });
    expect((await receivePaymentWebhook(db, p, g.rawBody, g.headers)).status).toBe(200);
    expect(await db.reconciliationMismatch.count({ where: { kind: "UNKNOWN_ORDER", actual: { path: ["orderId"], equals: ghost } } })).toBe(1);
  });

  it("a Cashfree-format webhook, signed as documented, goes through the real Cashfree adapter to PAID", async () => {
    const p = fakeProvider();
    const { orderId } = await createdOrder(p);
    const total = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalPaise;
    const cfSecret = "cfsk_ma_test_integration_secret";
    const cashfree = createCashfreePaymentProvider(createCashfreeClient({ appId: "TEST-APP", secretKey: cfSecret, env: "sandbox", fetch: (() => { throw new Error("no network in tests"); }) as unknown as typeof fetch }));
    const rawBody = JSON.stringify({ data: { order: { order_id: `repart_${orderId}`, order_amount: total / 100 }, payment: { cf_payment_id: 555, payment_status: "SUCCESS", payment_amount: total / 100, payment_currency: "INR" } }, event_time: new Date().toISOString(), type: "PAYMENT_SUCCESS_WEBHOOK" }, null, 2);
    const ts = String(Date.now());
    const headers = new Headers({ "x-webhook-timestamp": ts, "x-webhook-signature": createHmac("sha256", cfSecret).update(ts + rawBody).digest("base64"), "x-idempotency-key": `cf_idem_${orderId}` });
    expect(await receivePaymentWebhook(db, cashfree, rawBody, headers)).toEqual({ status: 200, outcome: "processed" });
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).state).toBe("AWAITING_SELLER");
    expect(await receivePaymentWebhook(db, cashfree, rawBody, headers)).toEqual({ status: 200, outcome: "duplicate" });
  });

  it("the return page's provider check applies a success the webhook never delivered", async () => {
    const p = fakeProvider();
    const { orderId } = await createdOrder(p);
    const total = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalPaise;
    p.getPayments.mockResolvedValue([{ providerPaymentId: "cf_pay_1", status: "SUCCESS", amount: total, at: new Date() }]);
    expect(await confirmFromProvider(db, p, orderId)).toEqual({ state: "AWAITING_SELLER", paymentStatus: "SUCCESS" });
    expect(await confirmFromProvider(db, p, orderId)).toEqual({ state: "AWAITING_SELLER", paymentStatus: "SUCCESS" });
    expect(await db.orderEvent.count({ where: { orderId, toState: "PAID_HELD" } })).toBe(1);
  });
});

describe("abandoned checkout: expiry", () => {
  it("expires an unpaid order after its TTL, releasing the listing; nothing happens before", async () => {
    const p = fakeProvider();
    const { orderId, listingId } = await createdOrder(p);
    expect(await expirePayment(db, p, orderId)).toBe("not_due");
    const later = new Date(Date.now() + 60 * 60_000);
    expect(await expirePayment(db, p, orderId, later)).toBe("expired");
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true } });
    expect(o.state).toBe("CANCELLED");
    expect(o.payment!.status).toBe("EXPIRED");
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("LIVE");
    expect(await expirePayment(db, p, orderId, later)).toBe("not_due"); // idempotent
  });

  it("checks the provider first: a last-second payment is applied, not cancelled", async () => {
    const p = fakeProvider();
    const { orderId } = await createdOrder(p);
    const total = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalPaise;
    p.getPayments.mockResolvedValue([{ providerPaymentId: "cf_last", status: "SUCCESS", amount: total, at: new Date() }]);
    expect(await expirePayment(db, p, orderId, new Date(Date.now() + 60 * 60_000))).toBe("paid");
  });

  it("a provider outage stops the expiry (the job retries) instead of cancelling blindly", async () => {
    const p = fakeProvider({ getPayments: vi.fn(async () => { throw new CashfreeError("Cashfree did not respond in time.", null, "timeout", null, "r"); }) });
    const { orderId } = await createdOrder(p);
    await expect(expirePayment(db, p, orderId, new Date(Date.now() + 60 * 60_000))).rejects.toThrow(/respond in time/);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).state).toBe("CREATED");
  });

  it("money arriving after cancellation is flagged for an admin, who can refund it", async () => {
    const p = fakeProvider();
    const { orderId } = await createdOrder(p);
    const total = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalPaise;
    await expirePayment(db, p, orderId, new Date(Date.now() + 60 * 60_000));
    const w = signed({ orderId, amount: total });
    await receivePaymentWebhook(db, p, w.rawBody, w.headers);
    expect(await mismatches(orderId, "PAID_AFTER_CANCEL")).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).state).toBe("CANCELLED");
    await adminRefundOnly(db, { userId: "sample-user-admin" }, orderId, { reason: "Paid after the order expired" });
    expect(await db.refund.findFirstOrThrow({ where: { payment: { orderId } } })).toMatchObject({ amountPaise: total, status: "REQUESTED" });
  });
});

describe("refunds", () => {
  it("seller timeout cancels with a full refund that reverses the seller's split", async () => {
    const p = fakeProvider();
    const { orderId, total } = await paidOrder(p);
    expect(await sellerTimeout(db, orderId, new Date(Date.now() + 48 * 3_600_000))).toBe("cancelled");
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    const r = await db.refund.findFirstOrThrow({ where: { payment: { orderId } } });
    expect(o.state).toBe("CANCELLED");
    expect(r).toMatchObject({ amountPaise: total, vendorPortionPaise: o.vendorSharePaise, merchantPortionPaise: o.merchantSharePaise, withSplitReversal: true, status: "REQUESTED" });
    expect(await sellerTimeout(db, orderId, new Date(Date.now() + 48 * 3_600_000))).toBe("not_due");
  });

  it("processing sends it once with the stored key; the confirmed webhook makes it SUCCESS", async () => {
    const p = fakeProvider();
    const { orderId, total } = await paidOrder(p);
    await adminCancelOrder(db, { userId: "sample-user-admin" }, orderId, { reason: "Buyer asked by phone" });
    const r = await db.refund.findFirstOrThrow({ where: { payment: { orderId } } });
    expect(await processRefund(db, p, r.id)).toBe("PENDING");
    expect(p.refund.mock.calls[0]![0]).toMatchObject({ orderId, refundId: r.id, amount: total, vendorId: VENDOR, idempotencyKey: `refund:${orderId}:admin_cancel` });
    await processRefund(db, p, r.id); // PENDING → re-checks with getRefund, never creates another
    expect(p.refund).toHaveBeenCalledTimes(1);
    await applyRefundStatus(db, { refundId: r.id, providerRefundId: `pr_${r.id}`, status: "SUCCESS", amount: total });
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("SUCCESS");
    expect((await db.payment.findUniqueOrThrow({ where: { orderId } })).vendorSettlementStatus).toBe("REVERSED");
  });

  it("the same refund can't be requested twice, and never more than was paid", async () => {
    const p = fakeProvider();
    const { orderId } = await paidOrder(p);
    await adminCancelOrder(db, { userId: "sample-user-admin" }, orderId, { reason: "Cancel it", shipping: "0" });
    await expect(adminRefundOnly(db, { userId: "sample-user-admin" }, orderId, { reason: "Too much", item: "99999999" })).rejects.toBeInstanceOf(UserError);
    await adminRefundOnly(db, { userId: "sample-user-admin" }, orderId, { reason: "Delivery charge too", item: "0", check: "0" });
    await expect(adminRefundOnly(db, { userId: "sample-user-admin" }, orderId, { reason: "Again" })).rejects.toThrow(/Choose an amount|more than is left/);
    const sums = await db.refund.aggregate({ where: { payment: { orderId } }, _sum: { amountPaise: true } });
    expect(sums._sum.amountPaise).toBe((await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalPaise);
  });

  it("a definite provider rejection fails the refund; a timeout keeps it for a retry with the same key", async () => {
    const reject = fakeProvider({ refund: vi.fn(async () => { throw new CashfreeError("refund amount invalid", 400, "refund_invalid", "invalid_request_error", "r"); }) });
    const a = await paidOrder(reject);
    await adminCancelOrder(db, { userId: "sample-user-admin" }, a.orderId, { reason: "Reject test" });
    const ra = await db.refund.findFirstOrThrow({ where: { payment: { orderId: a.orderId } } });
    expect(await processRefund(db, reject, ra.id)).toBe("FAILED");

    let first = true;
    const flaky = fakeProvider({
      refund: vi.fn(async (i: RefundInput) => {
        if (first) { first = false; throw new CashfreeError("Cashfree did not respond in time.", null, "timeout", null, "r"); }
        return { providerRefundId: `pr_${i.refundId}`, status: "SUCCESS" as const };
      }),
    });
    const b = await paidOrder(flaky);
    await adminCancelOrder(db, { userId: "sample-user-admin" }, b.orderId, { reason: "Timeout test" });
    const rb = await db.refund.findFirstOrThrow({ where: { payment: { orderId: b.orderId } } });
    await expect(processRefund(db, flaky, rb.id)).rejects.toThrow(/respond in time/);
    expect((await db.refund.findUniqueOrThrow({ where: { id: rb.id } })).status).toBe("REQUESTED");
    expect(await processRefund(db, flaky, rb.id)).toBe("SUCCESS");
    const keys = flaky.refund.mock.calls.map((c) => c[0].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("after settlement the merchant funds the refund and a seller recovery is opened", async () => {
    const p = fakeProvider();
    const { orderId } = await paidOrder(p);
    await db.payment.update({ where: { orderId }, data: { vendorSettlementStatus: "SETTLED" } });
    await adminCancelOrder(db, { userId: "sample-user-admin" }, orderId, { reason: "Post-settlement" });
    const r = await db.refund.findFirstOrThrow({ where: { payment: { orderId } } });
    expect(r).toMatchObject({ afterSettlement: true, withSplitReversal: false });
    expect(await db.sellerRecovery.findUniqueOrThrow({ where: { refundId: r.id } })).toMatchObject({ amountPaise: r.vendorPortionPaise, status: "OPEN" });
    await processRefund(db, p, r.id);
    expect(p.refund.mock.calls[0]![0]).toMatchObject({ vendorId: null, vendorPortion: 0 });
  });
});

describe("seller settlement release", () => {
  async function completed(p: PaymentProvider) {
    const o = await paidOrder(p);
    await db.order.update({ where: { id: o.orderId }, data: { state: "COMPLETED" } });
    return o;
  }

  it("releases a completed order's held split once, to the seller's ACTIVE vendor", async () => {
    const p = fakeProvider();
    const { orderId } = await completed(p);
    expect(await releaseSettlement(db, p, orderId)).toBe("released");
    expect(await releaseSettlement(db, p, orderId)).toBe("already");
    expect(p.markSettlementEligible).toHaveBeenCalledTimes(1);
    expect(p.markSettlementEligible.mock.calls[0]![0]).toMatchObject({ orderId, vendorId: VENDOR });
    expect((await db.payment.findUniqueOrThrow({ where: { orderId } })).vendorSettlementStatus).toBe("ELIGIBLE");
  });

  it("an unresolved dispute, an inactive vendor or an unfinished order blocks the release", async () => {
    const p = fakeProvider();
    const disputed = await completed(p);
    await db.dispute.create({ data: { orderId: disputed.orderId, reason: "DOES_NOT_FIT", description: "Doesn't fit my bike", status: "OPEN" } });
    expect(await releaseSettlement(db, p, disputed.orderId)).toBe("blocked");

    const inactive = await completed(p);
    await db.payoutAccount.update({ where: { userId: SELLER }, data: { status: "ON_HOLD" } });
    try {
      expect(await releaseSettlement(db, p, inactive.orderId)).toBe("blocked");
    } finally {
      await db.payoutAccount.update({ where: { userId: SELLER }, data: { status: "ACTIVE" } });
    }
    const open = await paidOrder(p);
    expect(await releaseSettlement(db, p, open.orderId)).toBe("blocked");
    expect(p.markSettlementEligible).not.toHaveBeenCalled();
  });

  it("a provider error or timeout leaves the split HELD; the retry releases it once", async () => {
    let calls = 0;
    const p = fakeProvider({
      markSettlementEligible: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new CashfreeError("server error", 500, "api_error", "api_error", "r");
        if (calls === 2) throw new CashfreeError("Cashfree did not respond in time.", null, "timeout", null, "r");
      }),
    });
    const { orderId } = await completed(p);
    await expect(releaseSettlement(db, p, orderId)).rejects.toThrow();
    await expect(releaseSettlement(db, p, orderId)).rejects.toThrow(/respond in time/);
    expect((await db.payment.findUniqueOrThrow({ where: { orderId } })).vendorSettlementStatus).toBe("HELD");
    expect(await releaseSettlement(db, p, orderId)).toBe("released");
    expect(await releaseSettlement(db, p, orderId)).toBe("already");
    expect(calls).toBe(3);
  });

  it("tracks the provider's settlement; one settled while still held is flagged", async () => {
    const settled = { vendorId: VENDOR, amount: 0, settled: true, providerSettlementId: "54878", eligibleAt: null };
    const p = fakeProvider({ getOrderSettlement: vi.fn(async () => settled) });
    const released = await completed(p);
    await releaseSettlement(db, p, released.orderId);
    expect(await syncSettlement(db, p, released.orderId)).toBe("SETTLED");
    const held = await paidOrder(p);
    expect(await syncSettlement(db, p, held.orderId)).toBe("SETTLED");
    expect(await mismatches(held.orderId, "SETTLED_BEFORE_RELEASE")).toBe(1);
  });

  it("dispute resolution: release queues the payout, refund refunds; both need a reason", async () => {
    const p = fakeProvider();
    const o = await paidOrder(p);
    await db.order.update({ where: { id: o.orderId }, data: { state: "DISPUTED" } });
    await db.dispute.create({ data: { orderId: o.orderId, reason: "NOT_AS_DESCRIBED", description: "Scratched", status: "UNDER_REVIEW" } });
    await expect(resolveDispute(db, { userId: "sample-user-admin" }, o.orderId, { decision: "RELEASE", reason: "" })).rejects.toThrow();
    await resolveDispute(db, { userId: "sample-user-admin" }, o.orderId, { decision: "RELEASE", reason: "Photos match the listing" });
    expect((await db.order.findUniqueOrThrow({ where: { id: o.orderId } })).state).toBe("RESOLVED_RELEASE");
    expect(await db.outboxJob.count({ where: { queue: "orders", name: "releaseSettlement", payload: { equals: { orderId: o.orderId } } } })).toBe(1);
    expect(await releaseSettlement(db, p, o.orderId)).toBe("released");
  });
});

describe("sweep and reconciliation", () => {
  it("the sweep marks an open order whose provider hold deadline passed, once", async () => {
    const p = fakeProvider();
    const { orderId } = await paidOrder(p);
    await db.order.update({ where: { id: orderId }, data: { autoReleaseAt: new Date(Date.now() - 1000) } });
    await sweepOrders(db, p);
    const first = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).deadlineBreachedAt;
    expect(first).not.toBeNull();
    await sweepOrders(db, p);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).deadlineBreachedAt).toEqual(first);
    expect(await db.auditLog.count({ where: { entityId: orderId, action: "order.deadline_breached" } })).toBe(1);
  });

  it("reconciliation flags amount, status and split mismatches without changing any record", async () => {
    const p = fakeProvider();
    const { orderId, total } = await paidOrder(p);
    p.getOrder.mockResolvedValue({ providerOrderId: `cf_${orderId}`, status: "PAID", checkoutUrl: null, paymentSessionId: null, amount: total + 100 });
    p.getPayments.mockResolvedValue([{ providerPaymentId: "a", status: "SUCCESS", amount: total, at: null }]);
    p.getOrderSettlement.mockResolvedValue({ vendorId: "someone_else", amount: 1, settled: false, providerSettlementId: null, eligibleAt: null });
    const before = await db.payment.findUniqueOrThrow({ where: { orderId } });
    const r = await runReconciliation(db, p);
    expect(r.mismatches).toBeGreaterThanOrEqual(3);
    for (const kind of ["AMOUNT_MISMATCH", "SPLIT_VENDOR_MISMATCH", "SPLIT_AMOUNT_MISMATCH"]) expect(await db.reconciliationMismatch.count({ where: { orderId, kind, runId: r.runId } })).toBe(1);
    expect(await db.payment.findUniqueOrThrow({ where: { orderId } })).toEqual(before);
  });
});
