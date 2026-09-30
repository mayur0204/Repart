import "server-only";
import { randomUUID } from "node:crypto";
import { verifySignature } from "../signing";
import type { PaymentProvider, PaymentWebhookEvent, ProviderOrder, RefundResult, Settlement, VendorState } from "./types";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

type MockOrder = ProviderOrder & { vendorId: string; vendorShare: number; eligible: boolean };

/**
 * In-memory mock (M1 skeleton). M8 replaces the maps with DB-backed state, a fake
 * checkout page and signed fake webhooks, keeping this interface unchanged.
 */
export function createMockPaymentProvider(opts: { webhookSecret: string; baseUrl: string }): PaymentProvider {
  const vendors = new Map<string, VendorState>();
  const orders = new Map<string, MockOrder>();
  const refunds = new Map<string, RefundResult>();

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
      };
      orders.set(input.orderId, order);
      return order;
    },
    async getOrder(orderId) {
      return orders.get(orderId) ?? null;
    },
    async markSettlementEligible(orderId) {
      const order = orders.get(orderId);
      if (!order) throw new Error(`mock payment: unknown order ${orderId}`);
      order.eligible = true;
    },
    async refund(input) {
      const existing = refunds.get(input.idempotencyKey);
      if (existing) return existing;
      const result: RefundResult = { providerRefundId: `mock_refund_${randomUUID()}`, status: "SUCCESS" };
      refunds.set(input.idempotencyKey, result);
      return result;
    },
    async getSettlements(range) {
      const out: Settlement[] = [];
      for (const [orderId, o] of orders) {
        if (o.eligible) {
          out.push({ providerSettlementId: `mock_settle_${orderId}`, orderId, vendorId: o.vendorId, amount: o.vendorShare, settledAt: range.to });
        }
      }
      return out;
    },
    verifyWebhook(rawBody, headers) {
      return verifySignature(opts.webhookSecret, rawBody, headers.get(MOCK_SIGNATURE_HEADER));
    },
    parseWebhook(rawBody) {
      return JSON.parse(rawBody) as PaymentWebhookEvent;
    },
  };
}
