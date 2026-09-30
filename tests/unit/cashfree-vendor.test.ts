import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cashfreeVendorId, createCashfreePaymentProvider, createCashfreeVendorBody, mapVendorStatus, VENDOR_STATUS_MAP } from "@/server/adapters/payment/cashfree";
import { CASHFREE_VENDOR_STATUSES, CashfreeError, createCashfreeClient } from "@/server/adapters/payment/cashfree-client";
import type { CreateVendorInput } from "@/server/adapters/payment/types";
import { logger } from "@/server/logger";
import { isPayoutEligible, payoutOnboardingInput, REPART_SETTLEMENT_SCHEDULE, REPART_VENDOR_BUSINESS_TYPE } from "@/server/services/payment/vendor-onboarding";

const APP_ID = "TEST-APP-ID-123";
const SECRET = "cfsk_ma_test_SUPERSECRET_value_9876";
// Cashfree's documented sandbox test data (docs: payments/split/data-to-test). Not real people.
const TEST_ACCOUNT = "026291800001191";
const TEST_IFSC = "YESB0000262";
const TEST_PAN = "ABCPV1234D";

const bankInput: CreateVendorInput = {
  vendorId: "repart_vendor_sample_user_seller",
  name: "Sample Seller",
  email: "seller@example.com",
  phone: "+919876543210",
  accountType: "INDIVIDUAL",
  pan: TEST_PAN,
  payout: { method: "BANK", accountHolder: "Sample Seller", accountNumber: TEST_ACCOUNT, ifsc: TEST_IFSC },
  scheduleOption: REPART_SETTLEMENT_SCHEDULE.cashfreeScheduleOption,
  businessType: REPART_VENDOR_BUSINESS_TYPE,
  idempotencyKey: "3f2b8a52-7c1e-4d7a-9b1c-2a6f0e4d9c11",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(respond: () => Response | Promise<Response>) {
  const f = vi.fn(async () => respond());
  const provider = createCashfreePaymentProvider(createCashfreeClient({ appId: APP_ID, secretKey: SECRET, env: "sandbox", fetch: f as unknown as typeof fetch, timeoutMs: 30 }));
  const call = () => {
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    return { url, init, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null };
  };
  return { provider, call, f };
}

afterEach(() => vi.restoreAllMocks());

describe("Create Vendor request (POST /easy-split/vendors, API 2026-01-01)", () => {
  it("uses the endpoint, version, auth headers and a UUID idempotency key", async () => {
    const { provider, call } = setup(() => json(200, { vendor_id: bankInput.vendorId, status: "IN_BENE_CREATION" }));
    await provider.createVendor(bankInput);
    const { url, init, headers } = call();
    expect(url).toBe("https://sandbox.cashfree.com/pg/easy-split/vendors");
    expect(init.method).toBe("POST");
    expect(headers).toMatchObject({ "x-api-version": "2026-01-01", "x-client-id": APP_ID, "x-client-secret": SECRET, "x-idempotency-key": bankInput.idempotencyKey });
    expect(headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the request sent to Cashfree carries kyc_details.business_type = Retail and Shopping", async () => {
    const { provider, call } = setup(() => json(200, { vendor_id: bankInput.vendorId, status: "IN_BANK_VALIDATION" }));
    await provider.createVendor(bankInput);
    expect(call().body.kyc_details).toEqual({ account_type: "INDIVIDUAL", business_type: "Retail and Shopping", pan: TEST_PAN });
    expect(REPART_VENDOR_BUSINESS_TYPE).toBe("Retail and Shopping");
  });

  it("maps the body: vendor id, ACTIVE, name, email, 10-digit phone, schedule_option 1, KYC, and bank only", () => {
    expect(createCashfreeVendorBody(bankInput)).toEqual({
      vendor_id: "repart_vendor_sample_user_seller",
      status: "ACTIVE",
      name: "Sample Seller",
      email: "seller@example.com",
      phone: "9876543210",
      schedule_option: 1,
      kyc_details: { account_type: "INDIVIDUAL", business_type: "Retail and Shopping", pan: TEST_PAN },
      bank: { account_number: TEST_ACCOUNT, account_holder: "Sample Seller", ifsc: TEST_IFSC },
    });
    expect(REPART_SETTLEMENT_SCHEDULE.cashfreeScheduleOption).toBe(1);
  });

  it("UPI sends upi only, never bank", () => {
    const body = createCashfreeVendorBody({ ...bankInput, payout: { method: "UPI", accountHolder: "Sample Seller", vpa: "success@upi" } });
    expect(body).toHaveProperty("upi", { vpa: "success@upi", account_holder: "Sample Seller" });
    expect(body).not.toHaveProperty("bank");
    expect(createCashfreeVendorBody(bankInput)).not.toHaveProperty("upi");
  });

  it("sends GSTIN only when given; never a vendor_lob or verify_account field", () => {
    const body = createCashfreeVendorBody({ ...bankInput, accountType: "BUSINESS", gst: "29AAICP2912R1ZR" });
    expect(body.kyc_details).toEqual({ account_type: "BUSINESS", business_type: "Retail and Shopping", pan: TEST_PAN, gst: "29AAICP2912R1ZR" });
    expect(JSON.stringify(body)).not.toMatch(/vendor_lob|verify_account/);
  });

  it("vendor ids are stable per seller and use only letters, digits and underscore", () => {
    expect(cashfreeVendorId("sample-user-seller")).toBe("repart_vendor_sample_user_seller");
    expect(cashfreeVendorId("cm9x1y2z3")).toBe(cashfreeVendorId("cm9x1y2z3"));
    expect(cashfreeVendorId("a.b-c")).toMatch(/^[A-Za-z0-9_]+$/);
  });
});

describe("vendor status mapping: only ACTIVE is payout-eligible", () => {
  it("covers every documented status", () => {
    expect(Object.keys(VENDOR_STATUS_MAP).sort()).toEqual([...CASHFREE_VENDOR_STATUSES].sort());
  });
  it.each([
    ["IN_BANK_VALIDATION", "PENDING"],
    ["IN_BENE_CREATION", "PENDING"],
    ["IN_KYC_REVIEW", "PENDING"],
    ["BANK_VALIDATION_FAILED", "ACTION_REQUIRED"],
    ["BENE_CREATION_FAILED", "ACTION_REQUIRED"],
    ["ACTION_REQUIRED", "ACTION_REQUIRED"],
    ["ON_HOLD", "ON_HOLD"],
    ["BLOCKED", "BLOCKED"],
    ["DELETED", "BLOCKED"],
    ["SOMETHING_NEW", "PENDING"],
  ])("%s → %s, not eligible", (cf, repart) => {
    expect(mapVendorStatus(cf)).toBe(repart);
    expect(isPayoutEligible(mapVendorStatus(cf) as never)).toBe(false);
  });
  it("ACTIVE → ACTIVE, eligible", () => {
    expect(mapVendorStatus("ACTIVE")).toBe("ACTIVE");
    expect(isPayoutEligible("ACTIVE")).toBe(true);
    for (const s of ["NOT_STARTED", "SUBMITTED", "PENDING", "ACTION_REQUIRED", "ON_HOLD", "BLOCKED", "REJECTED"] as const) expect(isPayoutEligible(s)).toBe(false);
  });
});

describe("server-side validation of payout details", () => {
  const form = { accountType: "INDIVIDUAL", name: "Sample Seller", email: "seller@example.com", pan: "abcpv1234d", payoutMethod: "BANK", accountHolder: "Sample Seller", accountNumber: TEST_ACCOUNT, ifsc: "yesb0000262" };
  const issues = (v: object) => {
    const r = payoutOnboardingInput.safeParse(v);
    return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [String(i.path[0]), i.message]));
  };
  it("accepts a valid bank form and normalises PAN / IFSC", () => {
    const r = payoutOnboardingInput.parse(form);
    expect(r).toMatchObject({ pan: TEST_PAN, payout: { method: "BANK", ifsc: TEST_IFSC, accountNumber: TEST_ACCOUNT } });
  });
  it("never takes business_type from the browser", () => {
    const r = payoutOnboardingInput.parse({ ...form, businessType: "NBFC", business_type: "NBFC", kyc_details: { business_type: "NBFC" } });
    expect(JSON.stringify(r)).not.toMatch(/NBFC|business/i);
  });

  it("rejects both bank and UPI, and neither", () => {
    expect(issues({ ...form, vpa: "success@upi" })).toHaveProperty("vpa");
    expect(issues({ ...form, payoutMethod: "UPI", vpa: "success@upi" })).toHaveProperty("accountNumber");
    expect(issues({ ...form, payoutMethod: undefined })).toHaveProperty("payoutMethod");
    expect(issues({ ...form, accountNumber: "", ifsc: "" })).toHaveProperty("accountNumber");
  });
  it("rejects an invalid IFSC, UPI id, PAN, name and missing KYC", () => {
    expect(issues({ ...form, ifsc: "YESB1234" })).toHaveProperty("ifsc");
    expect(issues({ ...form, payoutMethod: "UPI", accountNumber: undefined, ifsc: undefined, vpa: "not-a-vpa" })).toHaveProperty("vpa");
    expect(issues({ ...form, payoutMethod: "UPI", accountNumber: undefined, ifsc: undefined, vpa: "na-me@ok-bank" })).toHaveProperty("vpa");
    expect(issues({ ...form, pan: "12345" })).toHaveProperty("pan");
    expect(issues({ ...form, pan: undefined })).toHaveProperty("pan");
    expect(issues({ ...form, accountType: undefined })).toHaveProperty("accountType");
    expect(issues({ ...form, name: "Bad <name>" })).toHaveProperty("name");
  });
});

describe("errors, timeouts and secrets", () => {
  it("a 4xx is a typed error with Cashfree's code and no credentials or submitted bank/PAN values", async () => {
    const warn = vi.spyOn(logger, "warn");
    const { provider } = setup(() => json(400, { message: `bank account ${TEST_ACCOUNT} with ${TEST_IFSC} and PAN ${TEST_PAN} invalid (${SECRET})`, code: "bank_account_invalid", type: "invalid_request_error" }));
    const err = await provider.createVendor(bankInput).catch((e) => e);
    expect(err).toBeInstanceOf(CashfreeError);
    expect(err).toMatchObject({ status: 400, code: "bank_account_invalid" });
    const surfaces = JSON.stringify([err.message, err.stack, warn.mock.calls]);
    for (const secret of [SECRET, APP_ID, TEST_ACCOUNT, TEST_IFSC, TEST_PAN, "seller@example.com"]) expect(surfaces).not.toContain(secret);
  });

  it("a 5xx is a typed error with the status", async () => {
    const { provider } = setup(() => json(503, { message: "service unavailable", code: "api_error", type: "api_error" }));
    await expect(provider.createVendor(bankInput)).rejects.toMatchObject({ status: 503 });
  });

  it("a timeout is retryable with the same idempotency key", async () => {
    let n = 0;
    const f = vi.fn((_: string, init: RequestInit) =>
      n++ === 0 ? new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason))) : Promise.resolve(json(200, { vendor_id: bankInput.vendorId, status: "IN_BENE_CREATION" })),
    );
    const provider = createCashfreePaymentProvider(createCashfreeClient({ appId: APP_ID, secretKey: SECRET, env: "sandbox", fetch: f as unknown as typeof fetch, timeoutMs: 20 }));
    await expect(provider.createVendor(bankInput)).rejects.toMatchObject({ code: "timeout" });
    await expect(provider.createVendor(bankInput)).resolves.toMatchObject({ status: "PENDING", providerStatus: "IN_BENE_CREATION" });
    const keys = f.mock.calls.map((c) => ((c[1] as RequestInit).headers as Record<string, string>)["x-idempotency-key"]);
    expect(keys).toEqual([bankInput.idempotencyKey, bankInput.idempotencyKey]);
  });

  it("Get Vendor: returns the mapped state, and null for 'vendor does not exist'", async () => {
    const ok = setup(() => json(200, { vendor_id: "v1", status: "IN_KYC_REVIEW", remarks: "KYC pending", bank: [{ account_number: TEST_ACCOUNT }] }));
    const state = await ok.provider.getVendorStatus("v1");
    expect(state).toEqual({ vendorId: "v1", status: "PENDING", providerStatus: "IN_KYC_REVIEW", remarks: "KYC pending" });
    expect(JSON.stringify(state)).not.toContain(TEST_ACCOUNT); // bank details in the response are dropped
    expect(ok.call().url).toBe("https://sandbox.cashfree.com/pg/easy-split/vendors/v1");
    const missing = setup(() => json(400, { message: "vendor does not exist", code: "api_request_failed", type: "invalid_request_error" }));
    expect(await missing.provider.getVendorStatus("nope")).toBeNull();
  });
});

describe("sandbox-only and server-only", () => {
  it("the client refuses anything but the sandbox", () => {
    expect(() => createCashfreeClient({ appId: APP_ID, secretKey: SECRET, env: "production" as never })).toThrow(/Only the Cashfree sandbox/);
  });
  it("the vendor service and Cashfree modules are server-only", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    for (const f of ["src/server/services/payment/vendor-onboarding.ts", "src/server/adapters/payment/cashfree.ts", "src/server/adapters/payment/cashfree-client.ts"]) {
      expect(readFileSync(root + f, "utf8").startsWith('import "server-only";')).toBe(true);
    }
    expect(readFileSync(root + "src/components/seller/payout-fields.tsx", "utf8")).not.toMatch(/@\/server|CASHFREE/);
  });
});
