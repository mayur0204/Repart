import "server-only";
import { randomUUID } from "node:crypto";
import { signBody, verifySignature } from "../signing";
import { WEBHOOK_MAX_AGE_MS, type OrderSettlement, type PaymentProvider, type PaymentWebhookEvent, type ProviderOrder, type ProviderPayment, type RefundResult, type VendorState } from "./types";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";
export const MOCK_TIMESTAMP_HEADER = "x-mock-timestamp";

type MockOrder = ProviderOrder & { vendorId: string; vendorShare: number; eligible: boolean; payments: ProviderPayment[] };
export type MockOutcome = "SUCCESS" | "FAILED" | "USER_DROPPED";

/** Signs a mock webhook like Cashfree does: HMAC over timestamp + raw body. */
export function signMockWebhook(secret: string, rawBody: string, timestampMs: number): Headers {
  return new Headers({ [MOCK_TIMESTAMP_HEADER]: String(timestampMs), [MOCK_SIGNATURE_HEADER]: signBody(secret, `${timestampMs}${rawBody}`), "content-type": "application/json" });
}

/**
 * In-memory mock provider (PLAN.md §7.3), same contract as Cashfree. Payments happen on the dev page
 * /dev/mock-checkout/[orderId], which calls `simulatePayment` and feeds the signed webhook it returns
 * through the normal webhook handler, so the verified-webhook path is exercised end to end.
 */
export function createMockPaymentProvider(opts: { webhookSecret: string; baseUrl: string }): PaymentProvider & {
  simulatePayment(orderId: string, outcome: MockOutcome, amount?: number): { rawBody: string; headers: Headers };
} {
  const vendors = new Map<string, VendorState>();
  const orders = new Map<string, MockOrder>();
  const refunds = new Map<string, RefundResult & { orderId: string; refundId: string }>();

  return {
    name: "mock",
    // Plan §7.3: the mock onboards instantly as ACTIVE; creating the same vendor id again returns it.
    async createVendor(input) {
      const existing = vendors.get(input.vendorId);
      if (existing) return existing;
      const state: VendorState = { vendorId: input.vendorId, status: "ACTIVE", providerStatus: "ACTIVE", remarks: null };
      vendors.set(input.vendorId, state);
      return state;
    },
    async getVendorStatus(vendorId) {
      return vendors.get(vendorId) ?? null;
    },
    async createOrder(input) {
      const existing = orders.get(input.orderId);
      if (existing) return existing;
      const order: MockOrder = {
        providerOrderId: `mock_order_${input.orderId}`,
        status: "CREATED",
        checkoutUrl: `${opts.baseUrl}/dev/mock-checkout/${input.orderId}`,
        paymentSessionId: null,
        amount: input.amount,
        vendorId: input.vendorId,
        vendorShare: input.vendorShare,
        eligible: false,
        payments: [],
      };
      orders.set(input.orderId, order);
      return order;
    },
    async getOrder(orderId) {
      return orders.get(orderId) ?? null;
    },
    async getPayments(orderId) {
      return orders.get(orderId)?.payments ?? [];
    },
    async markSettlementEligible({ orderId }) {
      const order = orders.get(orderId);
      if (order) order.eligible = true;
    },
    async getOrderSettlement(orderId): Promise<OrderSettlement | null> {
      const o = orders.get(orderId);
      if (!o) return null;
      return { vendorId: o.vendorId, amount: o.vendorShare, settled: o.eligible, providerSettlementId: o.eligible ? `mock_settle_${orderId}` : null, eligibleAt: null };
    },
    async refund(input) {
      const existing = refunds.get(input.idempotencyKey);
      if (existing) return { providerRefundId: existing.providerRefundId, status: existing.status };
      const result = { providerRefundId: `mock_refund_${randomUUID()}`, status: "SUCCESS" as const, orderId: input.orderId, refundId: input.refundId };
      refunds.set(input.idempotencyKey, result);
      return { providerRefundId: result.providerRefundId, status: result.status };
    },
    async getRefund(orderId, refundId) {
      for (const r of refunds.values()) if (r.orderId === orderId && r.refundId === refundId) return { providerRefundId: r.providerRefundId, status: r.status };
      return null;
    },
    verifyWebhook(rawBody, headers, now = new Date()) {
      const ts = Number(headers.get(MOCK_TIMESTAMP_HEADER));
      if (!Number.isFinite(ts) || Math.abs(now.getTime() - ts) > WEBHOOK_MAX_AGE_MS) return false;
      return verifySignature(opts.webhookSecret, `${ts}${rawBody}`, headers.get(MOCK_SIGNATURE_HEADER));
    },
    parseWebhook(rawBody) {
      const raw = JSON.parse(rawBody) as Omit<PaymentWebhookEvent, "at"> & { at?: string };
      return { ...raw, at: raw.at ? new Date(raw.at) : undefined };
    },
    simulatePayment(orderId, outcome, amount) {
      const o = orders.get(orderId);
      const payment: ProviderPayment = { providerPaymentId: `mock_pay_${randomUUID()}`, status: outcome, amount: amount ?? o?.amount ?? 0, at: new Date() };
      if (o) {
        o.payments.push(payment);
        if (outcome === "SUCCESS") o.status = "PAID";
      }
      const event: PaymentWebhookEvent = {
        providerEventId: `mock_evt_${randomUUID()}`,
        type: outcome === "SUCCESS" ? "PAYMENT_SUCCESS" : outcome === "FAILED" ? "PAYMENT_FAILED" : "PAYMENT_USER_DROPPED",
        providerType: `MOCK_PAYMENT_${outcome}`,
        orderId,
        providerPaymentId: payment.providerPaymentId,
        amount: payment.amount,
        currency: "INR",
        at: payment.at!,
      };
      const rawBody = JSON.stringify(event);
      return { rawBody, headers: signMockWebhook(opts.webhookSecret, rawBody, Date.now()) };
    },
  };
}
