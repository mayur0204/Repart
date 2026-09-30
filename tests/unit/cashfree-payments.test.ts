import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cashfreeRefundId, createCashfreeOrderBody, createCashfreePaymentProvider, legacyDateTime, mapRefundStatus, parseCashfreeWebhook, repartOrderId, repartRefundId } from "@/server/adapters/payment/cashfree";
import { createCashfreeClient } from "@/server/adapters/payment/cashfree-client";
import type { SplitOrderInput } from "@/server/adapters/payment/types";
import { logger } from "@/server/logger";

const SECRET = "cfsk_ma_test_SUPERSECRET_value_9876";
const APP_ID = "TEST-APP-ID-123";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sign = (ts: string, body: string, secret = SECRET) => createHmac("sha256", secret).update(ts + body).digest("base64");

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => json(200, {})) {
  const f = vi.fn(async (url: string, init: RequestInit) => respond(url, init));
  const provider = createCashfreePaymentProvider(createCashfreeClient({ appId: APP_ID, secretKey: SECRET, env: "sandbox", fetch: f as unknown as typeof fetch, timeoutMs: 30 }));
  const call = (i = 0) => {
    const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
    return { url, method: init.method, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null };
  };
  return { provider, call, f };
}
afterEach(() => vi.restoreAllMocks());

// Webhook 2025-01-01 / 2026-01-01 shape from Cashfree's Payment Webhooks page (customer fields abbreviated).
const successBody = JSON.stringify({
  data: {
    order: { order_id: "repart_cmorder123", order_amount: 10500.0, order_currency: "INR" },
    payment: { cf_payment_id: "1453995084705707520", payment_status: "SUCCESS", payment_amount: 10500.0, payment_currency: "INR", payment_time: "2026-09-30T11:47:22+05:30" },
    customer_details: { customer_phone: "9876543210" },
  },
  event_time: "2026-09-30T11:47:29+05:30",
  type: "PAYMENT_SUCCESS_WEBHOOK",
}, null, 2); // raw bodies arrive formatted; the signature covers the exact bytes

describe("Cashfree webhook verification (x-webhook-signature = base64 HMAC-SHA256(timestamp + raw body))", () => {
  const now = new Date("2026-09-30T06:17:30Z");
  const ts = String(now.getTime() - 1_000);
  const { provider } = setup();

  it("accepts the documented signature over the raw body", () => {
    expect(provider.verifyWebhook(successBody, new Headers({ "x-webhook-timestamp": ts, "x-webhook-signature": sign(ts, successBody) }), now)).toBe(true);
  });
  it("rejects a wrong secret, a changed body, a missing header and a re-serialised body", () => {
    expect(provider.verifyWebhook(successBody, new Headers({ "x-webhook-timestamp": ts, "x-webhook-signature": sign(ts, successBody, "other-secret") }), now)).toBe(false);
    expect(provider.verifyWebhook(successBody.replace(": 10500", ": 1"), new Headers({ "x-webhook-timestamp": ts, "x-webhook-signature": sign(ts, successBody) }), now)).toBe(false);
    expect(provider.verifyWebhook(successBody, new Headers({ "x-webhook-signature": sign(ts, successBody) }), now)).toBe(false);
    expect(provider.verifyWebhook(JSON.stringify(JSON.parse(successBody)), new Headers({ "x-webhook-timestamp": ts, "x-webhook-signature": sign(ts, successBody) }), now)).toBe(false);
  });
  it("rejects replays outside the 5-minute window, even with a valid signature", () => {
    const old = String(now.getTime() - 6 * 60_000);
    expect(provider.verifyWebhook(successBody, new Headers({ "x-webhook-timestamp": old, "x-webhook-signature": sign(old, successBody) }), now)).toBe(false);
  });
});

describe("Cashfree webhook mapping", () => {
  it("maps a payment success to RePart ids and paise, keyed by x-idempotency-key", () => {
    const e = parseCashfreeWebhook(successBody, new Headers({ "x-idempotency-key": "idem-1" }));
    expect(e).toMatchObject({ providerEventId: "idem-1", type: "PAYMENT_SUCCESS", orderId: "cmorder123", providerPaymentId: "1453995084705707520", amount: 1_050_000, currency: "INR" });
  });
  it("falls back to type + payment id + status for older webhook versions", () => {
    expect(parseCashfreeWebhook(successBody, new Headers()).providerEventId).toBe("PAYMENT_SUCCESS_WEBHOOK:1453995084705707520:SUCCESS");
  });
  it("maps failed and user-dropped payments, refunds, vendor settlements, and leaves anything else UNKNOWN", () => {
    const pay = (type: string, status: string) => JSON.stringify({ data: { order: { order_id: "repart_o1" }, payment: { cf_payment_id: 9, payment_status: status, payment_amount: 1 } }, type });
    expect(parseCashfreeWebhook(pay("PAYMENT_FAILED_WEBHOOK", "FAILED"), new Headers()).type).toBe("PAYMENT_FAILED");
    expect(parseCashfreeWebhook(pay("PAYMENT_USER_DROPPED_WEBHOOK", "USER_DROPPED"), new Headers()).type).toBe("PAYMENT_USER_DROPPED");
    const refund = parseCashfreeWebhook(JSON.stringify({ data: { refund: { cf_refund_id: 11, refund_id: "rfcmrefund1", order_id: "repart_o1", refund_amount: 2.0, refund_status: "SUCCESS" } }, type: "REFUND_STATUS_WEBHOOK" }), new Headers());
    expect(refund).toMatchObject({ type: "REFUND_STATUS", refundId: "cmrefund1", providerRefundId: "11", refundStatus: "SUCCESS", amount: 200, orderId: "o1" });
    expect(parseCashfreeWebhook(JSON.stringify({ data: { settlement: { settlement_id: 1, status: "SUCCESS", vendor_id: "v" } }, type: "VENDOR_SETTLEMENT_SUCCESS" }), new Headers()).type).toBe("VENDOR_SETTLEMENT");
    expect(parseCashfreeWebhook(JSON.stringify({ data: {}, type: "PAYMENT_CHARGES_WEBHOOK" }), new Headers()).type).toBe("UNKNOWN");
  });
  it("ignores orders RePart didn't create and maps ids both ways", () => {
    expect(repartOrderId("someone_else_123")).toBeUndefined();
    expect(repartRefundId(cashfreeRefundId("cm_ref-1"))).toBe("cmref1");
    expect(cashfreeRefundId("x".repeat(60))).toHaveLength(40);
  });
  it("refund statuses: only SUCCESS succeeds; CANCELLED and REJECTED fail; the rest stay pending", () => {
    expect(["SUCCESS", "PENDING", "PENDING_APPROVAL", "ONHOLD", "CANCELLED", "REJECTED"].map(mapRefundStatus)).toEqual(["SUCCESS", "PENDING", "PENDING", "PENDING", "FAILED", "FAILED"]);
  });
});

describe("Easy Split order split at Create Order", () => {
  const input: SplitOrderInput = { orderId: "o1", amount: 1_050_000, vendorId: "repart_vendor_s1", vendorShare: 970_000, customer: { id: "b1", phone: "+919876543210" }, returnUrl: "http://x/r", idempotencyKey: "k" };
  it("sends only the seller's share (₹9,700 of ₹10,500) to the seller's vendor", () => {
    const body = createCashfreeOrderBody(input);
    expect(body.order_amount).toBe(10_500);
    expect(body.order_splits).toEqual([{ vendor_id: "repart_vendor_s1", amount: 9_700 }]);
  });
  it("sends no split without a vendor or with nothing to split", () => {
    expect(createCashfreeOrderBody({ ...input, vendorId: "" })).not.toHaveProperty("order_splits");
    expect(createCashfreeOrderBody({ ...input, vendorShare: 0 })).not.toHaveProperty("order_splits");
  });
});

describe("Cashfree payments, refunds and settlement calls", () => {
  it("Get Payments maps statuses and rupees to paise", async () => {
    const { provider, call } = setup(() => json(200, [{ cf_payment_id: 5, payment_status: "SUCCESS", payment_amount: 10500.5, payment_time: "2026-09-30T11:00:00+05:30" }, { cf_payment_id: 6, payment_status: "WEIRD", payment_amount: 1 }]));
    const payments = await provider.getPayments("o1");
    expect(call().url).toBe("https://sandbox.cashfree.com/pg/orders/repart_o1/payments");
    expect(payments[0]).toMatchObject({ providerPaymentId: "5", status: "SUCCESS", amount: 1_050_050 });
    expect(payments[1]!.status).toBe("PENDING");
  });

  it("Create Refund reverses the seller's portion with refund_splits and a stable idempotency key", async () => {
    const { provider, call } = setup(() => json(200, { cf_refund_id: 77, refund_id: "rfr1", order_id: "repart_o1", refund_amount: 10500, refund_status: "PENDING" }));
    const r = await provider.refund({ orderId: "o1", refundId: "r1", amount: 1_050_000, vendorId: "repart_vendor_s1", vendorPortion: 970_000, note: "RePart refund r1", idempotencyKey: "refund:o1:x" });
    const c = call();
    expect(c.url).toBe("https://sandbox.cashfree.com/pg/orders/repart_o1/refunds");
    expect(c.body).toEqual({ refund_amount: 10_500, refund_id: "rfr1", refund_note: "RePart refund r1", refund_splits: [{ vendor_id: "repart_vendor_s1", amount: 9_700 }] });
    expect(c.headers["x-idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(r).toEqual({ providerRefundId: "77", status: "PENDING" });
  });

  it("a merchant-only refund sends no refund_splits", async () => {
    const { provider, call } = setup(() => json(200, { cf_refund_id: 1, refund_id: "rfr2", order_id: "repart_o1", refund_amount: 3, refund_status: "SUCCESS" }));
    await provider.refund({ orderId: "o1", refundId: "r2", amount: 300, vendorId: null, vendorPortion: 0, note: "x", idempotencyKey: "k" });
    expect(call().body).not.toHaveProperty("refund_splits");
    expect(call().body.refund_note).toHaveLength(3); // Cashfree needs at least 3 characters
  });

  it("releases a held split with the documented v2 settlement-eligibility call on the sandbox host", async () => {
    const { provider, call } = setup(() => json(200, { status: "OK", subCode: "200", message: "Updated vendor settlement eligibility date." }));
    await provider.markSettlementEligible({ orderId: "o1", vendorId: "repart_vendor_s1", at: new Date("2026-09-30T10:00:00Z") });
    const c = call();
    expect(c.url).toBe("https://test.cashfree.com/api/v2/easy-split/orders/repart_o1/settlement-eligibility/vendors/repart_vendor_s1");
    expect(c.method).toBe("PUT");
    expect(c.body).toEqual({ settlementEligibilityDateUpdate: "2026-09-30 10:00:00" });
    expect(legacyDateTime(new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02 03:04:05");
  });

  it("reads the seller's split and settlement from split/order/vendor/recon", async () => {
    const { provider, call } = setup(() =>
      json(200, { data: [{ merchant_order_id: "repart_o1", entity_type: "transaction" }, { merchant_order_id: "repart_o1", entity_type: "vendor_commission", merchant_vendor_id: "repart_vendor_s1", vendor_commission: "9700.00", settled: "YES", vendor_settlement_id: "54878" }] }),
    );
    expect(await provider.getOrderSettlement("o1")).toMatchObject({ vendorId: "repart_vendor_s1", amount: 970_000, settled: true, providerSettlementId: "54878" });
    expect(call().body).toEqual({ filters: { order_ids: ["repart_o1"] }, pagination: { limit: 10 } });
  });

  it("errors never expose the secret key", async () => {
    const warn = vi.spyOn(logger, "warn");
    const { provider } = setup(() => json(400, { message: `refund failed for ${SECRET} / ${APP_ID}`, code: "refund_invalid", type: "invalid_request_error" }));
    const err = await provider.refund({ orderId: "o1", refundId: "r3", amount: 100, vendorId: null, vendorPortion: 0, note: "x", idempotencyKey: "k" }).catch((e) => e);
    expect(JSON.stringify([err.message, err.stack, warn.mock.calls])).not.toMatch(new RegExp(`${SECRET}|${APP_ID}`));
  });
});
