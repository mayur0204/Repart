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
/** All RePart ids; the adapter maps them to provider ids. `vendorPortion` > 0 reverses that much from the seller's split. */
export type RefundInput = { orderId: string; refundId: string; amount: Paise; vendorId: string | null; vendorPortion: Paise; note: string; idempotencyKey: string };
export type RefundState = "PENDING" | "SUCCESS" | "FAILED";
export type RefundResult = { providerRefundId: string; status: RefundState };

/** One payment attempt on a provider order (Cashfree: Get Payments for an Order). */
export type ProviderPayment = {
  providerPaymentId: string;
  status: "SUCCESS" | "FAILED" | "PENDING" | "USER_DROPPED" | "CANCELLED" | "VOID" | "NOT_ATTEMPTED";
  amount: Paise;
  at: Date | null;
};

/** The seller's split on one order and whether the provider has settled it (Cashfree: split/order/vendor/recon). */
export type OrderSettlement = { vendorId: string; amount: Paise; settled: boolean; providerSettlementId: string | null; eligibleAt: Date | null };

/**
 * A verified provider webhook, normalised. Amounts are paise. `providerEventId` is the delivery's dedupe key.
 * UNKNOWN events are stored and acknowledged but never acted on.
 */
export type PaymentWebhookEvent = {
  providerEventId: string;
  type: "PAYMENT_SUCCESS" | "PAYMENT_FAILED" | "PAYMENT_USER_DROPPED" | "REFUND_STATUS" | "VENDOR_SETTLEMENT" | "UNKNOWN";
  providerType: string;
  orderId?: string; // RePart order id
  providerPaymentId?: string;
  amount?: Paise;
  currency?: string;
  refundId?: string; // RePart refund id
  providerRefundId?: string;
  refundStatus?: RefundState;
  vendorId?: string;
  settlementStatus?: string;
  at?: Date;
};

/** Webhooks older (or newer) than this are rejected as replays (Cashfree recommends 5 minutes). */
export const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

/** Split-payment provider (REPART_BRIEF.md §3, PLAN.md §7). Mock first; Cashfree Easy Split at M8. */
export interface PaymentProvider {
  readonly name: string;
  createVendor(input: CreateVendorInput): Promise<VendorState>;
  /** null when the provider has no such vendor. */
  getVendorStatus(vendorId: string): Promise<VendorState | null>;
  /** Creates the provider order with the seller's split attached (`vendorShare` to `vendorId`). */
  createOrder(input: SplitOrderInput): Promise<ProviderOrder>;
  getOrder(orderId: string): Promise<ProviderOrder | null>;
  getPayments(orderId: string): Promise<ProviderPayment[]>;
  /** Releases the held seller split so the provider settles it on the vendor's schedule. Idempotent. */
  markSettlementEligible(input: { orderId: string; vendorId: string; at: Date }): Promise<void>;
  getOrderSettlement(orderId: string): Promise<OrderSettlement | null>;
  refund(input: RefundInput): Promise<RefundResult>;
  getRefund(orderId: string, refundId: string): Promise<RefundResult | null>;
  /** Signature + timestamp (replay) check on the raw body. Never throws for bad input. */
  verifyWebhook(rawBody: string, headers: Headers, now?: Date): boolean;
  parseWebhook(rawBody: string, headers: Headers): PaymentWebhookEvent;
}
