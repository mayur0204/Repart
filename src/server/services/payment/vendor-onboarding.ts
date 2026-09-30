import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PayoutOnboardingStatus, PrismaClient } from "@/generated/prisma/client";
import { cashfreeVendorId } from "../../adapters/payment/cashfree";
import { CashfreeError } from "../../adapters/payment/cashfree-client";
import type { PaymentProvider, VendorState } from "../../adapters/payment/types";
import { FieldError, UserError } from "../../http/errors";
import { logger } from "../../logger";
import { recordAudit } from "../audit/audit";

/**
 * Seller payout onboarding as a Cashfree Easy Split vendor (PLAN.md §7.2 step 1, M8 step 3).
 *
 * - Bank / UPI / PAN / GST values are validated here, passed straight to the provider, and never stored
 *   or logged (PayoutAccount keeps only method, vendor id, statuses and the retry key).
 * - The vendor id is derived from the seller id, so it is stable; the idempotency key is a stored UUID
 *   reused for every retry of the same request. Before retrying an attempt whose outcome is unknown,
 *   the provider is asked whether the vendor already exists, so a vendor is never created twice.
 * - Only ACTIVE is payout-eligible.
 */
type Db = PrismaClient;
type Actor = { userId: string; requestId?: string };

/** RePart's settlement schedule for vendor payouts: Cashfree schedule_option 1 = T+1 at 11:00 AM. Never instant. */
export const REPART_SETTLEMENT_SCHEDULE = { cashfreeScheduleOption: 1, description: "Next working day (T+1) at 11:00 AM" } as const;

/** Cashfree kyc_details.business_type for every RePart vendor. Set here only, never taken from the browser. */
export const REPART_VENDOR_BUSINESS_TYPE = "Retail and Shopping";

export const isPayoutEligible = (status: PayoutOnboardingStatus | null | undefined) => status === "ACTIVE";

// ── validation (never trust the browser) ──
const NAME = /^[A-Za-z0-9 ./&-]{3,100}$/; // Cashfree: max 100, special chars . / - & only
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GST = /^[0-9]{2}[A-Z0-9]{13}$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^[0-9]{9,18}$/;
const VPA = /^(?=.{3,100}$)[A-Za-z0-9._-]+@[A-Za-z0-9._]+$/; // "-" only before "@"
const trimUpper = z.string().trim().transform((v) => v.replace(/\s+/g, "").toUpperCase());
const blank = (v: string | undefined) => !v || !v.trim();

export const payoutOnboardingInput = z
  .object({
    accountType: z.enum(["INDIVIDUAL", "BUSINESS"], { message: "Choose individual or business." }),
    name: z.string().trim().regex(NAME, "Enter your name as on your bank account or PAN (letters, digits, spaces and . / - & only, 3 to 100 characters)."),
    email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")),
    pan: trimUpper.pipe(z.string().regex(PAN, "Enter a valid 10-character PAN, for example ABCPV1234D.")),
    gst: z.string().optional().transform((v) => (blank(v) ? null : v!.replace(/\s+/g, "").toUpperCase())).pipe(z.string().regex(GST, "Enter a valid 15-character GSTIN, or leave it empty.").nullable()),
    payoutMethod: z.enum(["BANK", "UPI"], { message: "Choose bank account or UPI." }),
    accountHolder: z.string().trim().regex(NAME, "Enter the account holder's name (letters, digits, spaces and . / - & only)."),
    accountNumber: z.string().optional(),
    ifsc: z.string().optional(),
    vpa: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (v.payoutMethod === "BANK") {
      if (!v.accountNumber || !ACCOUNT.test(v.accountNumber.replace(/\s+/g, ""))) issue("accountNumber", "Enter your bank account number (9 to 18 digits).");
      if (!v.ifsc || !IFSC.test(v.ifsc.trim().toUpperCase())) issue("ifsc", "Enter a valid 11-character IFSC, for example YESB0000262.");
      if (!blank(v.vpa)) issue("vpa", "Remove the UPI id: choose either a bank account or UPI, not both.");
    } else {
      if (!v.vpa || !VPA.test(v.vpa.trim())) issue("vpa", "Enter a valid UPI id, for example name@bank.");
      if (!blank(v.accountNumber) || !blank(v.ifsc)) issue("accountNumber", "Remove the bank details: choose either a bank account or UPI, not both.");
    }
  })
  .transform((v) => ({
    accountType: v.accountType,
    name: v.name,
    email: v.email,
    pan: v.pan,
    gst: v.gst,
    payout:
      v.payoutMethod === "BANK"
        ? { method: "BANK" as const, accountHolder: v.accountHolder, accountNumber: v.accountNumber!.replace(/\s+/g, ""), ifsc: v.ifsc!.trim().toUpperCase() }
        : { method: "UPI" as const, accountHolder: v.accountHolder, vpa: v.vpa!.trim() },
  }));

export type PayoutSummary = {
  status: PayoutOnboardingStatus;
  providerStatus: string | null;
  payoutMethod: "BANK" | "UPI" | null;
  remarks: string | null;
  checkedAt: Date | null;
  eligible: boolean;
  /** The seller can (re)submit details: nothing sent yet, or a previous attempt wasn't confirmed. */
  canSubmit: boolean;
  schedule: string;
};

type Account = NonNullable<Awaited<ReturnType<Db["payoutAccount"]["findUnique"]>>>;

function summary(a: Account | null): PayoutSummary {
  const status = a?.status ?? "NOT_STARTED";
  return {
    status,
    providerStatus: a?.providerStatus ?? null,
    payoutMethod: a?.payoutMethod ?? null,
    remarks: a?.statusReason ?? null,
    checkedAt: a?.statusCheckedAt ?? null,
    eligible: isPayoutEligible(status),
    canSubmit: status === "NOT_STARTED" || status === "SUBMITTED",
    schedule: REPART_SETTLEMENT_SCHEDULE.description,
  };
}

export async function getPayoutSummary(db: Pick<Db, "payoutAccount">, userId: string) {
  return summary(await db.payoutAccount.findUnique({ where: { userId } }));
}

async function applyState(db: Db, account: Account, state: VendorState, actor: { type: "USER" | "SYSTEM"; id: string | null }, action: string, requestId?: string) {
  const updated = await db.$transaction(async (tx) => {
    const u = await tx.payoutAccount.update({
      where: { id: account.id },
      data: { status: state.status, providerStatus: state.providerStatus, statusReason: state.remarks?.slice(0, 500) ?? null, statusCheckedAt: new Date() },
    });
    if (account.status !== u.status || account.providerStatus !== u.providerStatus || action !== "payout.status_synced") {
      await recordAudit(tx, {
        actor,
        action,
        entity: { type: "PayoutAccount", id: account.id },
        before: { status: account.status, providerStatus: account.providerStatus },
        after: { status: u.status, providerStatus: u.providerStatus, vendorId: u.providerVendorId },
        requestId,
      });
    }
    return u;
  });
  return updated;
}

/**
 * Submit payout details: validates, then creates (or reconciles) the provider vendor. Safe to call
 * twice: an existing vendor is never duplicated.
 */
export async function submitPayoutOnboarding(db: Db, provider: PaymentProvider, actor: Actor, raw: unknown): Promise<PayoutSummary> {
  const user = await db.user.findUnique({ where: { id: actor.userId }, select: { id: true, phone: true, status: true } });
  if (!user || user.status !== "ACTIVE") throw new UserError("Your account can't set up payouts. Contact support.");
  const parsed = payoutOnboardingInput.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[String(i.path[0] ?? "form")] ??= i.message;
    throw new FieldError(fields);
  }
  const input = parsed.data;

  let account = await db.payoutAccount.findUnique({ where: { userId: user.id } });
  if (account && !summary(account).canSubmit) return syncPayoutStatus(db, provider, user.id, { force: true });

  // An earlier attempt may have reached the provider: reconcile before sending again.
  if (account?.status === "SUBMITTED" && account.providerVendorId) {
    const existing = await provider.getVendorStatus(account.providerVendorId);
    if (existing) return summary(await applyState(db, account, existing, { type: "USER", id: user.id }, "payout.vendor_created", actor.requestId));
  }

  const vendorId = account?.providerVendorId ?? cashfreeVendorId(user.id);
  const idempotencyKey = account?.vendorIdempotencyKey ?? randomUUID();
  account = await db.payoutAccount.upsert({
    where: { userId: user.id },
    create: { userId: user.id, provider: provider.name, providerVendorId: vendorId, vendorIdempotencyKey: idempotencyKey, status: "SUBMITTED", payoutMethod: input.payout.method, settlementScheduleOption: REPART_SETTLEMENT_SCHEDULE.cashfreeScheduleOption },
    update: { provider: provider.name, providerVendorId: vendorId, vendorIdempotencyKey: idempotencyKey, status: "SUBMITTED", payoutMethod: input.payout.method, settlementScheduleOption: REPART_SETTLEMENT_SCHEDULE.cashfreeScheduleOption, statusReason: null },
  });

  let state: VendorState;
  try {
    state = await provider.createVendor({
      vendorId,
      name: input.name,
      email: input.email,
      phone: user.phone,
      accountType: input.accountType,
      pan: input.pan,
      gst: input.gst,
      payout: input.payout,
      scheduleOption: REPART_SETTLEMENT_SCHEDULE.cashfreeScheduleOption,
      businessType: REPART_VENDOR_BUSINESS_TYPE,
      idempotencyKey,
    });
  } catch (err) {
    if (err instanceof CashfreeError && err.status !== null && err.status < 500 && err.status !== 409 && err.status !== 422) {
      // Definite rejection: no vendor was created. A fresh key lets corrected details be sent.
      await db.payoutAccount.update({ where: { id: account.id }, data: { status: "NOT_STARTED", vendorIdempotencyKey: null, statusReason: err.message.slice(0, 500) } });
      logger.warn({ userId: user.id, vendorId, status: err.status, code: err.code }, "payout vendor rejected");
      throw new UserError(`Our payment partner couldn't accept these details: ${err.message}`);
    }
    // Outcome unknown (timeout, network, 5xx, 409/422): stay SUBMITTED and retry with the same key.
    await db.payoutAccount.update({ where: { id: account.id }, data: { statusReason: "Waiting for confirmation from our payment partner." } });
    logger.warn({ userId: user.id, vendorId, code: err instanceof CashfreeError ? err.code : "error" }, "payout vendor outcome unknown");
    throw new UserError("We couldn't confirm your details with our payment partner. Try again in a minute: your details won't be duplicated.");
  }
  return summary(await applyState(db, account, state, { type: "USER", id: user.id }, "payout.vendor_created", actor.requestId));
}

/**
 * Refresh the vendor status from the provider (seller page, admin, a future webhook/job).
 * Skipped when checked within `minAgeMs` unless forced; no background polling loop.
 */
export async function syncPayoutStatus(db: Db, provider: PaymentProvider, userId: string, opts: { force?: boolean; minAgeMs?: number } = {}): Promise<PayoutSummary> {
  const account = await db.payoutAccount.findUnique({ where: { userId } });
  if (!account?.providerVendorId || account.provider !== provider.name || account.status === "NOT_STARTED") return summary(account);
  const fresh = account.statusCheckedAt && Date.now() - account.statusCheckedAt.getTime() < (opts.minAgeMs ?? 60_000);
  if (fresh && !opts.force) return summary(account);
  const state = await provider.getVendorStatus(account.providerVendorId);
  if (!state) return summary(account); // not created yet (e.g. still SUBMITTED)
  return summary(await applyState(db, account, state, { type: "SYSTEM", id: null }, "payout.status_synced"));
}
