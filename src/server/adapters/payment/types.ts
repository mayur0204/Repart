/** Amounts are integer paise everywhere (PLAN.md §1.2 "Money"). */
export type Paise = number;

export type VendorStatus = "PENDING" | "ACTIVE" | "REJECTED" | "SUSPENDED";

export type CreateVendorInput = { userId: string; displayName: string; email?: string; phone: string };
export type SplitOrderInput = {
  orderId: string;
  amount: Paise;
  vendorId: string;
  vendorShare: Paise;
  customer: { id: string; phone: string };
  returnUrl: string;
  idempotencyKey: string;
};
export type ProviderOrder = {
  providerOrderId: string;
  status: "CREATED" | "PAID" | "FAILED" | "EXPIRED";
  checkoutUrl: string;
  amount: Paise;
};
export type RefundInput = { orderId: string; amount: Paise; splitReversal: Paise; idempotencyKey: string };
export type RefundResult = { providerRefundId: string; status: "PENDING" | "SUCCESS" | "FAILED" };
export type Settlement = { providerSettlementId: string; orderId: string; vendorId: string; amount: Paise; settledAt: Date };

export type PaymentWebhookEvent = {
  providerEventId: string;
  type: "PAYMENT_SUCCESS" | "PAYMENT_FAILED" | "REFUND_STATUS" | "SETTLEMENT" | "VENDOR_STATUS";
  orderId?: string;
  data: Record<string, unknown>;
};

/** Split-payment provider (REPART_BRIEF.md §3, PLAN.md §7). Mock first; Cashfree Easy Split at M8. */
export interface PaymentProvider {
  readonly name: string;
  createVendor(input: CreateVendorInput): Promise<{ vendorId: string; status: VendorStatus }>;
  getVendorStatus(vendorId: string): Promise<VendorStatus>;
  createOrder(input: SplitOrderInput): Promise<ProviderOrder>;
  getOrder(orderId: string): Promise<ProviderOrder | null>;
  markSettlementEligible(orderId: string): Promise<void>;
  refund(input: RefundInput): Promise<RefundResult>;
  getSettlements(range: { from: Date; to: Date }): Promise<Settlement[]>;
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  parseWebhook(rawBody: string): PaymentWebhookEvent;
}
