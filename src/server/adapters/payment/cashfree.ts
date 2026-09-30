import "server-only";
import { createHash } from "node:crypto";
import { CashfreeError, type CashfreeClient, type CashfreeOrder, type CashfreeRefund, type CashfreeVendor, type CashfreeVendorRequest, type CashfreeVendorStatus } from "./cashfree-client";
import {
  WEBHOOK_MAX_AGE_MS,
  type CreateVendorInput,
  type PaymentProvider,
  type PaymentWebhookEvent,
  type ProviderOrder,
  type ProviderPayment,
  type RefundResult,
  type RefundState,
  type SplitOrderInput,
  type VendorState,
  type VendorStatus,
} from "./types";

/**
 * Cashfree PaymentProvider (PLAN.md §7.4), sandbox only, through the shared Cashfree client.
 * Easy Split model (docs checked 2026-09-30): the seller's split is attached at Create Order (`order_splits`);
 * the account's Defer Settlement holds it (max 45 days, then Cashfree auto-releases); RePart releases it early
 * with Set Vendor Settlement Eligibility Date when the order completes. Refunds reverse the split with
 * `refund_splits`. Payment results come from signed webhooks, with Get Payments as the fallback.
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

/** refund_id: 3–40 alphanumeric characters. Maps back with `repartRefundId`. */
export const cashfreeRefundId = (refundId: string) => `rf${refundId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 40);
export const repartRefundId = (cfRefundId: string) => (/^rf[A-Za-z0-9]+$/.test(cfRefundId) ? cfRefundId.slice(2) : undefined);
/** RePart order id back from a Cashfree order_id ("repart_<id>"); undefined for orders RePart didn't create. */
export const repartOrderId = (cfOrderId: string | undefined) => (cfOrderId?.startsWith("repart_") ? cfOrderId.slice("repart_".length) : undefined);
/** Rupees (a JSON number, up to 2 decimals) → integer paise. */
export const rupeesToPaise = (rupees: number) => Math.round(rupees * 100);

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
    // Easy Split at order creation: only the seller's share goes to the vendor; the rest stays with RePart.
    ...(input.vendorId && input.vendorShare > 0 ? { order_splits: [{ vendor_id: input.vendorId, amount: input.vendorShare / 100 }] } : {}),
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

const PAYMENT_STATUSES = new Set<ProviderPayment["status"]>(["SUCCESS", "FAILED", "PENDING", "USER_DROPPED", "CANCELLED", "VOID", "NOT_ATTEMPTED"]);

/** Cashfree refund_status → RePart. Only SUCCESS is final success; CANCELLED/REJECTED are failures. */
export function mapRefundStatus(s: string): RefundState {
  if (s === "SUCCESS") return "SUCCESS";
  if (s === "CANCELLED" || s === "REJECTED") return "FAILED";
  return "PENDING"; // PENDING, PENDING_APPROVAL, ONHOLD, anything new
}
const toRefundResult = (r: CashfreeRefund): RefundResult => ({ providerRefundId: String(r.cf_refund_id), status: mapRefundStatus(r.refund_status) });

/** Cashfree's legacy settlement API takes "YYYY-MM-DD HH:mm:ss". Sent in UTC: whichever zone Cashfree reads it in, it is not in the future. */
export const legacyDateTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

const CF_EVENT_TYPES: Record<string, PaymentWebhookEvent["type"]> = {
  PAYMENT_SUCCESS_WEBHOOK: "PAYMENT_SUCCESS",
  PAYMENT_FAILED_WEBHOOK: "PAYMENT_FAILED",
  PAYMENT_USER_DROPPED_WEBHOOK: "PAYMENT_USER_DROPPED",
  REFUND_STATUS_WEBHOOK: "REFUND_STATUS",
  AUTO_REFUND_STATUS_WEBHOOK: "REFUND_STATUS",
  VENDOR_SETTLEMENT_CREATED: "VENDOR_SETTLEMENT",
  VENDOR_SETTLEMENT_INITIATED: "VENDOR_SETTLEMENT",
  VENDOR_SETTLEMENT_SUCCESS: "VENDOR_SETTLEMENT",
  VENDOR_SETTLEMENT_FAILED: "VENDOR_SETTLEMENT",
  VENDOR_SETTLEMENT_REVERSED: "VENDOR_SETTLEMENT",
};

type CfWebhookBody = {
  type?: string;
  event_time?: string;
  data?: {
    order?: { order_id?: string };
    payment?: { cf_payment_id?: string | number; payment_amount?: number; payment_currency?: string; payment_status?: string };
    refund?: { cf_refund_id?: string | number; refund_id?: string; order_id?: string; refund_amount?: number; refund_status?: string; refund_currency?: string };
    settlement?: { settlement_id?: string | number; status?: string; vendor_id?: string };
  };
};

/** Maps a verified Cashfree webhook (payment, refund or vendor settlement; webhook version 2025-01-01+) to RePart's event. */
export function parseCashfreeWebhook(rawBody: string, headers: Headers): PaymentWebhookEvent {
  const body = JSON.parse(rawBody) as CfWebhookBody;
  const providerType = String(body.type ?? "UNKNOWN");
  const type = CF_EVENT_TYPES[providerType] ?? "UNKNOWN";
  const pay = body.data?.payment;
  const refund = body.data?.refund;
  const settlement = body.data?.settlement;
  const subject = pay?.cf_payment_id ?? refund?.cf_refund_id ?? settlement?.settlement_id ?? "none";
  const status = pay?.payment_status ?? refund?.refund_status ?? settlement?.status ?? "";
  return {
    // Cashfree sends x-idempotency-key per event (webhook 2025-01-01+); older versions fall back to type + subject + status.
    providerEventId: headers.get("x-idempotency-key") ?? `${providerType}:${subject}:${status}`,
    type,
    providerType,
    orderId: repartOrderId(body.data?.order?.order_id ?? refund?.order_id),
    providerPaymentId: pay?.cf_payment_id === undefined ? undefined : String(pay.cf_payment_id),
    amount: typeof pay?.payment_amount === "number" ? rupeesToPaise(pay.payment_amount) : typeof refund?.refund_amount === "number" ? rupeesToPaise(refund.refund_amount) : undefined,
    currency: pay?.payment_currency ?? refund?.refund_currency,
    refundId: refund?.refund_id ? repartRefundId(refund.refund_id) : undefined,
    providerRefundId: refund?.cf_refund_id === undefined ? undefined : String(refund.cf_refund_id),
    refundStatus: refund?.refund_status ? mapRefundStatus(refund.refund_status) : undefined,
    vendorId: settlement?.vendor_id,
    settlementStatus: settlement?.status,
    at: body.event_time ? new Date(body.event_time) : undefined,
  };
}

const notFound = (err: unknown) => err instanceof CashfreeError && (err.status === 404 || (err.status === 400 && /not found|does not exist/i.test(err.message)));

export function createCashfreePaymentProvider(client: CashfreeClient): PaymentProvider {
  return {
    name: "cashfree",
    async createOrder(input) {
      const body = createCashfreeOrderBody(input);
      const order = await client.request<CashfreeOrder>("POST", "/orders", { body, idempotencyKey: idempotencyUuid(input.idempotencyKey) });
      return toProviderOrder(order);
    },
    async getOrder(orderId) {
      try {
        return toProviderOrder(await client.getOrder(cashfreeOrderId(orderId)));
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },
    async getPayments(orderId) {
      const rows = await client.getPayments(cashfreeOrderId(orderId));
      return (Array.isArray(rows) ? rows : []).map((p) => ({
        providerPaymentId: String(p.cf_payment_id),
        status: PAYMENT_STATUSES.has(p.payment_status as ProviderPayment["status"]) ? (p.payment_status as ProviderPayment["status"]) : "PENDING",
        amount: rupeesToPaise(p.payment_amount),
        at: p.payment_time ? new Date(p.payment_time) : null,
      }));
    },
    async markSettlementEligible({ orderId, vendorId, at }) {
      await client.setSettlementEligibility(cashfreeOrderId(orderId), vendorId, legacyDateTime(at));
    },
    async getOrderSettlement(orderId) {
      const cfId = cashfreeOrderId(orderId);
      const res = await client.splitRecon([cfId]);
      const row = (res.data ?? []).find((r) => r.entity_type === "vendor_commission" && r.merchant_order_id === cfId);
      if (!row?.merchant_vendor_id) return null;
      return {
        vendorId: row.merchant_vendor_id,
        amount: rupeesToPaise(Number(row.vendor_commission ?? 0)),
        settled: row.settled === "YES",
        providerSettlementId: row.vendor_settlement_id ? String(row.vendor_settlement_id) : null,
        eligibleAt: row.vendor_settlement_eligibility_time ? new Date(row.vendor_settlement_eligibility_time.replace(" ", "T")) : null,
      };
    },
    async refund(input) {
      const body = {
        refund_amount: input.amount / 100,
        refund_id: cashfreeRefundId(input.refundId),
        refund_note: input.note.slice(0, 100).padEnd(3, "."),
        ...(input.vendorId && input.vendorPortion > 0 ? { refund_splits: [{ vendor_id: input.vendorId, amount: input.vendorPortion / 100 }] } : {}),
      };
      return toRefundResult(await client.createRefund(cashfreeOrderId(input.orderId), body, idempotencyUuid(input.idempotencyKey)));
    },
    async getRefund(orderId, refundId) {
      try {
        return toRefundResult(await client.getRefund(cashfreeOrderId(orderId), cashfreeRefundId(refundId)));
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
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
    verifyWebhook(rawBody, headers, now = new Date()) {
      const ts = headers.get("x-webhook-timestamp");
      const ms = Number(ts);
      // Replay protection: Cashfree's timestamp is epoch milliseconds; reject anything outside the window.
      if (!ts || !Number.isFinite(ms) || Math.abs(now.getTime() - ms) > WEBHOOK_MAX_AGE_MS) return false;
      return client.verifyWebhookSignature(rawBody, ts, headers.get("x-webhook-signature"));
    },
    parseWebhook: parseCashfreeWebhook,
  };
}
