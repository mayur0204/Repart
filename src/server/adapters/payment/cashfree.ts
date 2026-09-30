import "server-only";
import { createHash } from "node:crypto";
import { CashfreeError, type CashfreeClient, type CashfreeOrder, type CashfreeVendor, type CashfreeVendorRequest, type CashfreeVendorStatus } from "./cashfree-client";
import type { CreateVendorInput, PaymentProvider, ProviderOrder, SplitOrderInput, VendorState, VendorStatus } from "./types";

/**
 * Cashfree PaymentProvider (PLAN.md §7.4), sandbox only, through the shared Cashfree client.
 * Implemented: order creation/lookup (M8 step 2) and Easy Split vendor create/status (M8 step 3).
 * Order splits, refunds, settlements and webhooks are later M8 steps and fail loudly until then.
 */

/** Cashfree order_id: 3–45 chars, letters, digits, "_" and "-". */
export function cashfreeOrderId(repartOrderId: string): string {
  const id = `repart_${repartOrderId}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (id.length > 45) throw new Error(`order id too long for Cashfree: ${id.length} chars`);
  return id;
}

/** customer_id: alphanumeric only, 3–50 chars. */
export const cashfreeCustomerId = (userId: string) => `u${userId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 50);

/** customer_phone: 10 digits for Indian numbers (E.164 +91XXXXXXXXXX in RePart). */
export const cashfreePhone = (e164: string) => e164.replace(/^\+91(?=\d{10}$)/, "");

/** x-idempotency-key is documented as a UUID: derive a stable one from RePart's idempotency key. */
export function idempotencyUuid(key: string): string {
  const h = createHash("sha256").update(`repart:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Integer paise → rupees with up to two decimals, as Cashfree's order_amount expects (minimum ₹1). */
export function paiseToRupees(paise: number): number {
  if (!Number.isInteger(paise) || paise < 100) throw new Error(`order amount must be whole paise and at least ₹1, got ${paise}`);
  return paise / 100;
}

const STATUS: Record<CashfreeOrder["order_status"], ProviderOrder["status"]> = {
  ACTIVE: "CREATED",
  PAID: "PAID",
  EXPIRED: "EXPIRED",
  TERMINATED: "FAILED",
  TERMINATION_REQUESTED: "FAILED",
};

function toProviderOrder(o: CashfreeOrder): ProviderOrder {
  if (!o || typeof o.cf_order_id !== "string" || !STATUS[o.order_status] || typeof o.order_amount !== "number") {
    throw new Error("Cashfree returned an order without the expected fields.");
  }
  return {
    providerOrderId: o.cf_order_id,
    status: STATUS[o.order_status],
    checkoutUrl: null,
    paymentSessionId: o.payment_session_id ?? null,
    amount: Math.round(o.order_amount * 100),
  };
}

export function createCashfreeOrderBody(input: SplitOrderInput) {
  return {
    order_id: cashfreeOrderId(input.orderId),
    order_amount: paiseToRupees(input.amount),
    order_currency: "INR",
    customer_details: {
      customer_id: cashfreeCustomerId(input.customer.id),
      customer_phone: cashfreePhone(input.customer.phone),
      ...(input.customer.name && input.customer.name.length >= 3 ? { customer_name: input.customer.name.slice(0, 100) } : {}),
      ...(input.customer.email ? { customer_email: input.customer.email.slice(0, 100) } : {}),
    },
    order_meta: {
      return_url: input.returnUrl,
      ...(input.notifyUrl?.startsWith("https://") ? { notify_url: input.notifyUrl } : {}),
    },
    ...(input.expiresAt ? { order_expiry_time: input.expiresAt.toISOString() } : {}),
    // ponytail: no order_splits yet; Easy Split (vendorId/vendorShare) is wired in a later M8 step.
  };
}

/**
 * Cashfree vendor status → RePart onboarding state. Only ACTIVE is payout-eligible; anything unknown is
 * treated as still processing (never eligible).
 */
export const VENDOR_STATUS_MAP: Record<CashfreeVendorStatus, VendorStatus> = {
  IN_BANK_VALIDATION: "PENDING",
  IN_BENE_CREATION: "PENDING",
  IN_KYC_REVIEW: "PENDING",
  BANK_VALIDATION_FAILED: "ACTION_REQUIRED",
  BENE_CREATION_FAILED: "ACTION_REQUIRED",
  ACTION_REQUIRED: "ACTION_REQUIRED",
  ACTIVE: "ACTIVE",
  ON_HOLD: "ON_HOLD",
  BLOCKED: "BLOCKED",
  DELETED: "BLOCKED",
};
export const mapVendorStatus = (s: string): VendorStatus => VENDOR_STATUS_MAP[s as CashfreeVendorStatus] ?? "PENDING";

/** Cashfree vendor_id: letters, digits and underscore. Stable per seller. */
export const cashfreeVendorId = (sellerId: string) => `repart_vendor_${sellerId.replace(/[^A-Za-z0-9_]/g, "_")}`;

// kyc_details.business_type: the schema marks it optional, but the sandbox rejects its absence (kyc_details.business_type_missing);
// "Retail and Shopping" was accepted there on 2026-09-30. verify_account is optional and chargeable, so it is not sent.
export function createCashfreeVendorBody(input: CreateVendorInput): CashfreeVendorRequest {
  const base = {
    vendor_id: input.vendorId,
    status: "ACTIVE" as const,
    name: input.name,
    email: input.email,
    phone: cashfreePhone(input.phone),
    schedule_option: input.scheduleOption,
    kyc_details: { account_type: input.accountType, business_type: input.businessType, pan: input.pan, ...(input.gst ? { gst: input.gst } : {}) },
  };
  return input.payout.method === "BANK"
    ? { ...base, bank: { account_number: input.payout.accountNumber, account_holder: input.payout.accountHolder, ifsc: input.payout.ifsc } }
    : { ...base, upi: { vpa: input.payout.vpa, account_holder: input.payout.accountHolder } };
}

const toVendorState = (v: CashfreeVendor): VendorState => {
  if (!v || typeof v.vendor_id !== "string" || typeof v.status !== "string") throw new Error("Cashfree returned a vendor without the expected fields.");
  return { vendorId: v.vendor_id, status: mapVendorStatus(v.status), providerStatus: v.status, remarks: v.remarks ?? null };
};

const later = (what: string) => async () => {
  throw new Error(`Cashfree ${what} is not implemented yet (later M8 step).`);
};

export function createCashfreePaymentProvider(client: CashfreeClient): PaymentProvider {
  return {
    name: "cashfree",
    async createOrder(input) {
      const body = createCashfreeOrderBody(input);
      const order = await client.request<CashfreeOrder>("POST", "/orders", { body, idempotencyKey: idempotencyUuid(input.idempotencyKey) });
      return toProviderOrder(order);
    },
    async getOrder(orderId) {
      return toProviderOrder(await client.getOrder(cashfreeOrderId(orderId)));
    },
    async createVendor(input) {
      return toVendorState(await client.createVendor(createCashfreeVendorBody(input), input.idempotencyKey));
    },
    async getVendorStatus(vendorId) {
      try {
        return toVendorState(await client.getVendor(vendorId));
      } catch (err) {
        // Documented: an unknown vendor is HTTP 400 "vendor does not exist".
        if (err instanceof CashfreeError && err.status === 400 && /does not exist/i.test(err.message)) return null;
        throw err;
      }
    },
    markSettlementEligible: later("settlement release"),
    refund: later("refunds"),
    getSettlements: later("settlements"),
    verifyWebhook: () => {
      throw new Error("Cashfree webhooks are not implemented yet (later M8 step).");
    },
    parseWebhook: () => {
      throw new Error("Cashfree webhooks are not implemented yet (later M8 step).");
    },
  };
}
