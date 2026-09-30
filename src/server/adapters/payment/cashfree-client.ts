import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "../../env";
import { logger } from "../../logger";

/**
 * Cashfree Payments (PG) API client: the only place that talks to Cashfree (PLAN.md §7.4).
 * SANDBOX ONLY (decision D-9). Per the official docs (API reference "latest"):
 *   base URL  https://sandbox.cashfree.com/pg
 *   headers   x-client-id, x-client-secret, x-api-version: 2026-01-01
 *   errors    JSON { message, code, type, help? } with 400/401/404/409/422/429/500
 * Credentials never leave this module: they are not logged, and error messages are scrubbed of them.
 */
export const CASHFREE_API_VERSION = "2026-01-01";
export const CASHFREE_BASE_URL = { sandbox: "https://sandbox.cashfree.com/pg" } as const;
/**
 * Easy Split "Set Vendor Settlement Eligibility Date" is only documented on the older v2 API
 * (docs: payments/split/settlements/delay/vendor-level, sandbox host test.cashfree.com). Sandbox only.
 */
export const CASHFREE_LEGACY_BASE_URL = { sandbox: "https://test.cashfree.com/api/v2" } as const;
const DEFAULT_TIMEOUT_MS = 15_000;

export type CashfreeConfig = {
  appId: string;
  secretKey: string;
  env: keyof typeof CASHFREE_BASE_URL;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

/** Documented error body. */
export type CashfreeErrorBody = { message?: string; code?: string; type?: string; help?: string };

/** Minimal OrderEntity fields later M8 steps need (Get/Create Order). */
export type CashfreeOrder = {
  cf_order_id: string;
  order_id: string;
  order_status: "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED" | "TERMINATION_REQUESTED";
  order_amount: number;
  order_currency: string;
  order_expiry_time?: string;
  payment_session_id?: string;
  created_at?: string;
};

/** Easy Split vendor statuses documented by Cashfree (vendor onboarding guide). */
export const CASHFREE_VENDOR_STATUSES = [
  "IN_BANK_VALIDATION",
  "BANK_VALIDATION_FAILED",
  "IN_BENE_CREATION",
  "BENE_CREATION_FAILED",
  "IN_KYC_REVIEW",
  "ACTION_REQUIRED",
  "ACTIVE",
  "ON_HOLD",
  "BLOCKED",
  "DELETED",
] as const;
export type CashfreeVendorStatus = (typeof CASHFREE_VENDOR_STATUSES)[number];

/** POST /easy-split/vendors body (API 2026-01-01). Exactly one of bank / upi. */
export type CashfreeVendorRequest = {
  vendor_id: string;
  status: "ACTIVE";
  name: string;
  email: string;
  phone: string;
  schedule_option: number;
  kyc_details: { account_type: "INDIVIDUAL" | "BUSINESS"; business_type: string; pan: string; gst?: string };
} & ({ bank: { account_number: string; account_holder: string; ifsc: string }; upi?: never } | { upi: { vpa: string; account_holder: string }; bank?: never });

/**
 * The vendor fields RePart reads back. The real response also carries bank/UPI details
 * (unmasked in Get Vendor); those are never read, logged or stored.
 */
export type CashfreeVendor = { vendor_id: string; status: string; remarks?: string | null };

/** GET /orders/{order_id}/payments item (fields RePart reads). */
export type CashfreePayment = { cf_payment_id: string | number; payment_status: string; payment_amount: number; payment_currency?: string; payment_time?: string | null };

/** POST /orders/{order_id}/refunds body (API 2026-01-01). refund_splits reverses the vendor's split. */
export type CashfreeRefundRequest = { refund_amount: number; refund_id: string; refund_note: string; refund_splits?: Array<{ vendor_id: string; amount: number }> };
/** RefundEntity fields RePart reads. */
export type CashfreeRefund = { cf_refund_id: string | number; refund_id: string; order_id: string; refund_amount: number; refund_status: string };

/** POST /split/order/vendor/recon row (fields RePart reads). */
export type CashfreeSplitReconRow = {
  merchant_order_id?: string;
  entity_type?: string;
  merchant_vendor_id?: string;
  vendor_commission?: string;
  settled?: string;
  vendor_settlement_id?: string | null;
  vendor_settlement_eligibility_time?: string | null;
};

export class CashfreeError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly type: string | null,
    readonly requestId: string,
  ) {
    super(message);
    this.name = "CashfreeError";
  }
}

export function cashfreeHeaders(cfg: Pick<CashfreeConfig, "appId" | "secretKey">, extra: { requestId: string; idempotencyKey?: string }): Record<string, string> {
  return {
    "x-client-id": cfg.appId,
    "x-client-secret": cfg.secretKey,
    "x-api-version": CASHFREE_API_VERSION,
    "x-request-id": extra.requestId,
    "content-type": "application/json",
    accept: "application/json",
    ...(extra.idempotencyKey ? { "x-idempotency-key": extra.idempotencyKey } : {}),
  };
}

export function createCashfreeClient(cfg: CashfreeConfig) {
  if (!cfg.appId || !cfg.secretKey) throw new Error("Cashfree is not configured: set CASHFREE_APP_ID and CASHFREE_SECRET_KEY.");
  if (cfg.env !== "sandbox") throw new Error("Only the Cashfree sandbox is allowed.");
  const base = CASHFREE_BASE_URL[cfg.env];
  const doFetch = cfg.fetch ?? fetch;
  // Never let a credential reach a message, even if Cashfree echoes it back.
  const scrub = (s: string) => s.split(cfg.secretKey).join("[redacted]").split(cfg.appId).join("[redacted]");

  /** `redact`: request values (bank, UPI, PAN, ...) that must never appear in an error message either. */
  async function request<T>(method: "GET" | "POST" | "PATCH" | "PUT", path: string, opts: { body?: unknown; idempotencyKey?: string; redact?: string[]; legacy?: boolean } = {}): Promise<T> {
    const requestId = randomUUID();
    const log = { cashfreeRequestId: requestId, method, path };
    let res: Response;
    try {
      res = await doFetch(`${opts.legacy ? CASHFREE_LEGACY_BASE_URL[cfg.env] : base}${path}`, {
        method,
        headers: cashfreeHeaders(cfg, { requestId, idempotencyKey: opts.idempotencyKey }),
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      logger.warn({ ...log, failure: timeout ? "timeout" : "network" }, "cashfree request failed");
      throw new CashfreeError(timeout ? "Cashfree did not respond in time." : "Couldn't reach Cashfree.", null, timeout ? "timeout" : "network_error", null, requestId);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body; handled below
    }
    if (!res.ok) {
      const e = (json ?? {}) as CashfreeErrorBody;
      logger.warn({ ...log, status: res.status, code: e.code, type: e.type }, "cashfree error response");
      const message = (opts.redact ?? []).filter((v) => v.length >= 3).reduce((m, v) => m.split(v).join("[redacted]"), scrub(e.message ?? `Cashfree returned HTTP ${res.status}.`));
      throw new CashfreeError(message, res.status, e.code ?? `http_${res.status}`, e.type ?? null, requestId);
    }
    if (json === null) throw new CashfreeError("Cashfree returned an empty or invalid response.", res.status, "invalid_response", null, requestId);
    return json as T;
  }

  return {
    request,
    /** GET /orders/{order_id} */
    getOrder: (orderId: string) => request<CashfreeOrder>("GET", `/orders/${encodeURIComponent(orderId)}`),
    /** POST /easy-split/vendors (Easy Split Create Vendor). */
    createVendor: (body: CashfreeVendorRequest, idempotencyKey: string) =>
      request<CashfreeVendor>("POST", "/easy-split/vendors", {
        body,
        idempotencyKey,
        redact: [body.bank?.account_number, body.bank?.ifsc, body.upi?.vpa, body.kyc_details.pan, body.kyc_details.gst, body.email, body.phone].filter((v): v is string => !!v),
      }),
    /** GET /easy-split/vendors/{vendor_id}. An unknown vendor is HTTP 400 "vendor does not exist". */
    getVendor: (vendorId: string) => request<CashfreeVendor>("GET", `/easy-split/vendors/${encodeURIComponent(vendorId)}`),
    /** GET /orders/{order_id}/payments */
    getPayments: (orderId: string) => request<CashfreePayment[]>("GET", `/orders/${encodeURIComponent(orderId)}/payments`),
    /** POST /orders/{order_id}/refunds */
    createRefund: (orderId: string, body: CashfreeRefundRequest, idempotencyKey: string) =>
      request<CashfreeRefund>("POST", `/orders/${encodeURIComponent(orderId)}/refunds`, { body, idempotencyKey }),
    /** GET /orders/{order_id}/refunds/{refund_id} */
    getRefund: (orderId: string, refundId: string) => request<CashfreeRefund>("GET", `/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`),
    /** POST /split/order/vendor/recon: split and settlement details for the given orders. */
    splitRecon: (orderIds: string[]) =>
      request<{ data?: CashfreeSplitReconRow[] }>("POST", "/split/order/vendor/recon", { body: { filters: { order_ids: orderIds }, pagination: { limit: 10 } } }),
    /** PUT (v2) /easy-split/orders/{order_id}/settlement-eligibility/vendors/{vendor_id} */
    setSettlementEligibility: (orderId: string, vendorId: string, settlementEligibilityDateUpdate: string) =>
      request<{ status?: string; message?: string }>("PUT", `/easy-split/orders/${encodeURIComponent(orderId)}/settlement-eligibility/vendors/${encodeURIComponent(vendorId)}`, {
        body: { settlementEligibilityDateUpdate },
        legacy: true,
      }),
    /**
     * Payment Gateway webhook signature (docs: payments/online/webhooks/signature-verification):
     * Base64(HMAC-SHA256(x-webhook-timestamp + rawBody, secret)), compared in constant time.
     */
    verifyWebhookSignature(rawBody: string, timestamp: string | null, signature: string | null): boolean {
      if (!timestamp || !signature) return false;
      const expected = Buffer.from(createHmac("sha256", cfg.secretKey).update(timestamp + rawBody).digest("base64"));
      const given = Buffer.from(signature);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
export type CashfreeClient = ReturnType<typeof createCashfreeClient>;

/** Client from the validated server env. */
export function cashfreeFromEnv(): CashfreeClient {
  const e = env();
  return createCashfreeClient({ appId: e.CASHFREE_APP_ID ?? "", secretKey: e.CASHFREE_SECRET_KEY ?? "", env: e.CASHFREE_ENV });
}
