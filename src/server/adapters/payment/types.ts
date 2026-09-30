/** Amounts are integer paise everywhere (PLAN.md §1.2 "Money"). */
export type Paise = number;

/** RePart payout-onboarding states a provider can report (PayoutOnboardingStatus). Only ACTIVE is payout-eligible. */
export type VendorStatus = "PENDING" | "ACTIVE" | "ACTION_REQUIRED" | "ON_HOLD" | "BLOCKED";
export type VendorState = { vendorId: string; status: VendorStatus; providerStatus: string; remarks: string | null };

export type VendorPayout =
  | { method: "BANK"; accountHolder: string; accountNumber: string; ifsc: string }
  | { method: "UPI"; accountHolder: string; vpa: string };

/** Everything the provider needs; bank/UPI/KYC values pass straight through and are never stored or logged. */
export type CreateVendorInput = {
  vendorId: string; // RePart-generated, stable across retries
  name: string;
  email: string;
  phone: string; // E.164
  accountType: "INDIVIDUAL" | "BUSINESS";
  pan: string;
  gst?: string | null;
  payout: VendorPayout;
  scheduleOption: number;
  businessType: string; // Cashfree kyc_details.business_type; a RePart-wide setting, never seller input
  idempotencyKey: string; // UUID, reused for every retry
};
export type SplitOrderInput = {
  orderId: string;
  amount: Paise;
  vendorId: string;
  vendorShare: Paise;
  customer: { id: string; phone: string; name?: string | null; email?: string | null };
  returnUrl: string;
  /** Server-to-server status notifications; Cashfree requires https, so it's omitted when not https. */
  notifyUrl?: string | null;
  expiresAt?: Date;
  idempotencyKey: string;
};
export type ProviderOrder = {
  providerOrderId: string;
  status: "CREATED" | "PAID" | "FAILED" | "EXPIRED";
  /** Hosted checkout page (mock); null for providers opened with a session id. */
  checkoutUrl: string | null;
  /** Cashfree payment_session_id, handed to the browser checkout; null for the mock. */
  paymentSessionId: string | null;
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
  createVendor(input: CreateVendorInput): Promise<VendorState>;
  /** null when the provider has no such vendor. */
  getVendorStatus(vendorId: string): Promise<VendorState | null>;
  createOrder(input: SplitOrderInput): Promise<ProviderOrder>;
  getOrder(orderId: string): Promise<ProviderOrder | null>;
  markSettlementEligible(orderId: string): Promise<void>;
  refund(input: RefundInput): Promise<RefundResult>;
  getSettlements(range: { from: Date; to: Date }): Promise<Settlement[]>;
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  parseWebhook(rawBody: string): PaymentWebhookEvent;
}
