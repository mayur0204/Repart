import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { CashfreeError } from "../../src/server/adapters/payment/cashfree-client";
import { createMockPaymentProvider } from "../../src/server/adapters/payment/mock";
import type { CreateVendorInput, PaymentProvider, VendorState } from "../../src/server/adapters/payment/types";
import { FieldError, UserError } from "../../src/server/http/errors";
import { getPayoutSummary, submitPayoutOnboarding, syncPayoutStatus } from "../../src/server/services/payment/vendor-onboarding";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
let n = 0;
// Cashfree sandbox test data only (docs: payments/split/data-to-test).
const form = { accountType: "INDIVIDUAL", name: "Sample Seller", email: "seller@example.com", pan: "ABCPV1234D", payoutMethod: "BANK", accountHolder: "Sample Seller", accountNumber: "026291800001191", ifsc: "YESB0000262" };

async function newSeller() {
  return db.user.create({ data: { phone: `+917${String(Date.now() % 1e5).padStart(5, "0")}${String(n++).padStart(4, "0")}`, name: "Sample Seller" } });
}

/** A Cashfree-shaped fake provider whose createVendor / getVendorStatus behaviour each test controls. */
function fakeProvider(opts: { create?: (i: CreateVendorInput) => Promise<VendorState>; get?: (id: string) => Promise<VendorState | null> } = {}) {
  const createVendor = vi.fn(opts.create ?? (async (i: CreateVendorInput) => ({ vendorId: i.vendorId, status: "PENDING" as const, providerStatus: "IN_BENE_CREATION", remarks: null })));
  const getVendorStatus = vi.fn(opts.get ?? (async () => null));
  const provider = { ...createMockPaymentProvider({ webhookSecret: "x".repeat(20), baseUrl: "" }), name: "cashfree", createVendor, getVendorStatus } as PaymentProvider;
  return { provider, createVendor, getVendorStatus };
}
const timeout = () => new CashfreeError("Cashfree did not respond in time.", null, "timeout", null, "r");

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
afterAll(async () => {
  await db.$disconnect();
});

describe("payout onboarding → Easy Split vendor", () => {
  it("creates the vendor with a stable id, schedule 1 and a stored UUID key; stores status but no bank/KYC data", async () => {
    const seller = await newSeller();
    const { provider, createVendor } = fakeProvider();
    const s = await submitPayoutOnboarding(db, provider, { userId: seller.id }, form);
    expect(s).toMatchObject({ status: "PENDING", providerStatus: "IN_BENE_CREATION", payoutMethod: "BANK", eligible: false, canSubmit: false });
    const sent = createVendor.mock.calls[0]![0];
    expect(sent).toMatchObject({ vendorId: `repart_vendor_${seller.id}`, scheduleOption: 1, businessType: "Retail and Shopping", phone: seller.phone, pan: "ABCPV1234D", payout: { method: "BANK" } });
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    const row = await db.payoutAccount.findUniqueOrThrow({ where: { userId: seller.id } });
    expect(row).toMatchObject({ provider: "cashfree", providerVendorId: `repart_vendor_${seller.id}`, vendorIdempotencyKey: sent.idempotencyKey, settlementScheduleOption: 1, payoutMethod: "BANK", status: "PENDING" });
    expect(JSON.stringify(row)).not.toMatch(/026291800001191|YESB0000262|ABCPV1234D/);
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: row.id, action: "payout.vendor_created" } });
    expect(JSON.stringify(audit)).not.toMatch(/026291800001191|ABCPV1234D/);
  });

  it("ignores a browser-supplied business_type: the RePart setting is always sent", async () => {
    const seller = await newSeller();
    const { provider, createVendor } = fakeProvider();
    await submitPayoutOnboarding(db, provider, { userId: seller.id }, { ...form, businessType: "NBFC", business_type: "NBFC" });
    expect(createVendor.mock.calls[0]![0].businessType).toBe("Retail and Shopping");
  });

  it("rejects bad input before any provider call", async () => {
    const seller = await newSeller();
    const { provider, createVendor } = fakeProvider();
    await expect(submitPayoutOnboarding(db, provider, { userId: seller.id }, { ...form, pan: undefined })).rejects.toBeInstanceOf(FieldError);
    await expect(submitPayoutOnboarding(db, provider, { userId: seller.id }, { ...form, vpa: "success@upi" })).rejects.toBeInstanceOf(FieldError);
    expect(createVendor).not.toHaveBeenCalled();
    expect(await db.payoutAccount.findUnique({ where: { userId: seller.id } })).toBeNull();
  });

  it("a timeout leaves it SUBMITTED; the retry reuses the same vendor id and idempotency key", async () => {
    const seller = await newSeller();
    let first = true;
    const { provider, createVendor } = fakeProvider({
      create: async (i) => {
        if (first) {
          first = false;
          throw timeout();
        }
        return { vendorId: i.vendorId, status: "PENDING", providerStatus: "IN_BENE_CREATION", remarks: null };
      },
    });
    await expect(submitPayoutOnboarding(db, provider, { userId: seller.id }, form)).rejects.toBeInstanceOf(UserError);
    expect((await getPayoutSummary(db, seller.id)).status).toBe("SUBMITTED");
    await submitPayoutOnboarding(db, provider, { userId: seller.id }, form);
    const [a, b] = createVendor.mock.calls.map((c) => c[0]);
    expect(b!.idempotencyKey).toBe(a!.idempotencyKey);
    expect(b!.vendorId).toBe(a!.vendorId);
  });

  it("if the timed-out request actually created the vendor, the retry reconciles instead of creating again", async () => {
    const seller = await newSeller();
    const { provider, createVendor } = fakeProvider({
      create: async () => {
        throw timeout();
      },
      get: async (id) => ({ vendorId: id, status: "ACTIVE", providerStatus: "ACTIVE", remarks: null }),
    });
    await expect(submitPayoutOnboarding(db, provider, { userId: seller.id }, form)).rejects.toBeInstanceOf(UserError);
    const s = await submitPayoutOnboarding(db, provider, { userId: seller.id }, form);
    expect(s).toMatchObject({ status: "ACTIVE", eligible: true });
    expect(createVendor).toHaveBeenCalledTimes(1);
  });

  it("an existing vendor is never duplicated: a second submit only refreshes the status", async () => {
    const seller = await newSeller();
    const { provider, createVendor, getVendorStatus } = fakeProvider({ get: async (id) => ({ vendorId: id, status: "PENDING", providerStatus: "IN_KYC_REVIEW", remarks: null }) });
    await submitPayoutOnboarding(db, provider, { userId: seller.id }, form);
    const again = await submitPayoutOnboarding(db, provider, { userId: seller.id }, form);
    expect(createVendor).toHaveBeenCalledTimes(1);
    expect(getVendorStatus).toHaveBeenCalled();
    expect(again.providerStatus).toBe("IN_KYC_REVIEW");
    expect(await db.payoutAccount.count({ where: { userId: seller.id } })).toBe(1);
  });

  it("a definite 4xx rejection resets to NOT_STARTED with a fresh key, so corrected details can be sent", async () => {
    const seller = await newSeller();
    const { provider } = fakeProvider({
      create: async () => {
        throw new CashfreeError("bank account [redacted] invalid", 400, "bank_account_invalid", "invalid_request_error", "r");
      },
    });
    await expect(submitPayoutOnboarding(db, provider, { userId: seller.id }, form)).rejects.toThrow(/couldn't accept these details/);
    const row = await db.payoutAccount.findUniqueOrThrow({ where: { userId: seller.id } });
    expect(row).toMatchObject({ status: "NOT_STARTED", vendorIdempotencyKey: null });
    expect((await getPayoutSummary(db, seller.id)).canSubmit).toBe(true);
  });

  it("a 5xx keeps it SUBMITTED for a safe retry", async () => {
    const seller = await newSeller();
    const { provider } = fakeProvider({
      create: async () => {
        throw new CashfreeError("server error", 500, "api_error", "api_error", "r");
      },
    });
    await expect(submitPayoutOnboarding(db, provider, { userId: seller.id }, form)).rejects.toBeInstanceOf(UserError);
    expect((await db.payoutAccount.findUniqueOrThrow({ where: { userId: seller.id } })).status).toBe("SUBMITTED");
  });

  it("status sync moves to ACTIVE (eligible), audits the change, and skips a fresh check unless forced", async () => {
    const seller = await newSeller();
    let status = "IN_BENE_CREATION";
    const { provider, getVendorStatus } = fakeProvider({ get: async (id) => ({ vendorId: id, status: status === "ACTIVE" ? "ACTIVE" : "PENDING", providerStatus: status, remarks: null }) });
    await submitPayoutOnboarding(db, provider, { userId: seller.id }, form);
    status = "ACTIVE";
    expect((await syncPayoutStatus(db, provider, seller.id)).status).toBe("PENDING"); // checked < 1 min ago
    expect(getVendorStatus).not.toHaveBeenCalled();
    const s = await syncPayoutStatus(db, provider, seller.id, { force: true });
    expect(s).toMatchObject({ status: "ACTIVE", eligible: true });
    const row = await db.payoutAccount.findUniqueOrThrow({ where: { userId: seller.id } });
    expect(await db.auditLog.count({ where: { entityId: row.id, action: "payout.status_synced" } })).toBe(1);
  });

  it("the mock provider onboards instantly as ACTIVE through the same service", async () => {
    const seller = await newSeller();
    const mock = createMockPaymentProvider({ webhookSecret: "x".repeat(20), baseUrl: "" });
    const s = await submitPayoutOnboarding(db, mock, { userId: seller.id }, { ...form, payoutMethod: "UPI", accountNumber: undefined, ifsc: undefined, vpa: "success@upi" });
    expect(s).toMatchObject({ status: "ACTIVE", eligible: true, payoutMethod: "UPI" });
  });
});
