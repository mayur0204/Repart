import "server-only";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { PaymentProvider, PaymentWebhookEvent } from "../../adapters/payment/types";
import { logger } from "../../logger";
import { recordAudit } from "../audit/audit";
import { selectedForAudit } from "../risk/rules";
import { transitionOrder } from "../order/state";
import { enqueueOutbox } from "../outbox/outbox";
import { getSettingsVersion } from "../settings/settings";
import { flagMismatch } from "./mismatch";
import { applyRefundStatus } from "./refunds";

/**
 * Payment results (PLAN.md §7.2 step 4). The verified webhook is the source of truth; Get Payments is the
 * fallback when a webhook can't reach us (local sandbox has no public https URL) and before expiring an order.
 * Both paths go through confirmPaid, which is idempotent and checks the amount against the RePart payment.
 */
type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
const SYSTEM = { type: "PROVIDER_WEBHOOK" as const, id: null };
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type WebhookResult = { status: number; outcome: "processed" | "duplicate" | "rejected" | "invalid" | "failed" };

/** Verify → parse → dedupe (WebhookEvent) → apply. Returns the HTTP status for the provider. */
export async function receivePaymentWebhook(db: Db, provider: PaymentProvider, rawBody: string, headers: Headers, now = new Date()): Promise<WebhookResult> {
  if (!provider.verifyWebhook(rawBody, headers, now)) {
    logger.warn({ provider: provider.name }, "payment webhook rejected: bad signature or stale timestamp");
    return { status: 401, outcome: "rejected" };
  }
  let event: PaymentWebhookEvent;
  try {
    event = provider.parseWebhook(rawBody, headers);
  } catch {
    return { status: 400, outcome: "invalid" };
  }
  // Store the normalised event only: the raw body carries customer phone/email we don't need to keep.
  const stored = { ...event, at: event.at?.toISOString() ?? null } as unknown as Prisma.InputJsonObject;
  let row: { id: string; processedAt: Date | null };
  try {
    row = await db.webhookEvent.create({ data: { provider: provider.name, providerEventId: event.providerEventId, type: event.providerType, signatureValid: true, payload: stored }, select: { id: true, processedAt: true } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    row = await db.webhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: provider.name, providerEventId: event.providerEventId } }, select: { id: true, processedAt: true } });
    if (row.processedAt) return { status: 200, outcome: "duplicate" };
  }
  try {
    await applyPaymentEvent(db, event, "webhook");
    await db.webhookEvent.update({ where: { id: row.id }, data: { processedAt: new Date(), error: null } });
    return { status: 200, outcome: "processed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.webhookEvent.update({ where: { id: row.id }, data: { error: message.slice(0, 500) } });
    logger.error({ provider: provider.name, eventId: event.providerEventId, err: message }, "payment webhook processing failed");
    return { status: 500, outcome: "failed" }; // the provider retries; processing is idempotent
  }
}

export async function applyPaymentEvent(db: Db, event: PaymentWebhookEvent, source: "webhook" | "poll"): Promise<void> {
  switch (event.type) {
    case "PAYMENT_SUCCESS":
      if (!event.orderId || !event.providerPaymentId || event.amount === undefined) return flagUnmatched(db, event);
      await confirmPaid(db, { orderId: event.orderId, providerPaymentId: event.providerPaymentId, amount: event.amount, currency: event.currency ?? "INR", at: event.at ?? new Date(), source, eventId: event.providerEventId });
      return;
    case "PAYMENT_FAILED":
    case "PAYMENT_USER_DROPPED":
      if (!event.orderId) return flagUnmatched(db, event);
      await recordFailedAttempt(db, event.orderId, event);
      return;
    case "REFUND_STATUS":
      if (event.refundId && event.refundStatus) await applyRefundStatus(db, { refundId: event.refundId, providerRefundId: event.providerRefundId ?? null, status: event.refundStatus, amount: event.amount });
      return;
    case "VENDOR_SETTLEMENT": // settlement batches aren't per order; per-order status comes from the split recon sync.
    case "UNKNOWN":
      return;
  }
}

async function flagUnmatched(db: Db, event: PaymentWebhookEvent) {
  await db.$transaction((tx) => flagMismatch(tx, { orderId: null, kind: "UNKNOWN_ORDER", expected: null, actual: { type: event.providerType, eventId: event.providerEventId } }));
}

/** A failed or abandoned attempt. The order stays CREATED until it expires, so the buyer can try again. */
async function recordFailedAttempt(db: Db, orderId: string, event: PaymentWebhookEvent) {
  await db.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { orderId }, select: { id: true, status: true } });
    if (!payment) return flagMismatch(tx, { orderId: null, kind: "UNKNOWN_ORDER", expected: null, actual: { type: event.providerType, orderId } });
    await tx.paymentEvent.create({ data: { paymentId: payment.id, type: event.type, providerEventId: event.providerEventId, payload: { providerPaymentId: event.providerPaymentId ?? null, amount: event.amount ?? null } } });
    if (payment.status === "CREATED" || payment.status === "PENDING") await tx.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
  });
}

/**
 * O2 + O4: record a successful payment and move the order on. Idempotent; never trusts the amount:
 * a payment that doesn't match the RePart total (or arrives for a cancelled order) is flagged, not applied.
 */
export async function confirmPaid(
  db: Db,
  p: { orderId: string; providerPaymentId: string; amount: number; currency: string; at: Date; source: "webhook" | "poll"; eventId: string },
): Promise<"paid" | "already_paid" | "flagged"> {
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { orderId: p.orderId }, include: { order: { select: { state: true, settingsVersion: true, inspectionReason: true, buyerId: true } } } });
    if (!payment) {
      await flagMismatch(tx, { orderId: null, kind: "UNKNOWN_ORDER", expected: null, actual: { orderId: p.orderId, providerPaymentId: p.providerPaymentId, amount: p.amount } });
      return "flagged";
    }
    await tx.paymentEvent.create({ data: { paymentId: payment.id, type: `PAYMENT_SUCCESS_${p.source.toUpperCase()}`, providerEventId: p.eventId, payload: { providerPaymentId: p.providerPaymentId, amount: p.amount, currency: p.currency } } });
    if (p.currency !== "INR" || p.amount !== payment.amountPaise) {
      await flagMismatch(tx, { orderId: p.orderId, kind: "AMOUNT_MISMATCH", expected: { amount: payment.amountPaise, currency: "INR" }, actual: { amount: p.amount, currency: p.currency, providerPaymentId: p.providerPaymentId } });
      return "flagged";
    }
    if (payment.status === "SUCCESS") {
      if (payment.providerPaymentId !== p.providerPaymentId) {
        await flagMismatch(tx, { orderId: p.orderId, kind: "DUPLICATE_PAYMENT", expected: { providerPaymentId: payment.providerPaymentId }, actual: { providerPaymentId: p.providerPaymentId, amount: p.amount } });
        return "flagged";
      }
      return "already_paid";
    }
    const paidAt = p.at;
    await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCESS", providerPaymentId: p.providerPaymentId, paidAt, vendorSettlementStatus: payment.vendorId ? "HELD" : "NOT_APPLICABLE" } });
    await recordAudit(tx, { actor: SYSTEM, action: "payment.succeeded", entity: { type: "Payment", id: payment.id }, before: { status: payment.status }, after: { status: "SUCCESS", amount: p.amount, source: p.source } });

    if (payment.order.state !== "CREATED") {
      // Money arrived for an order that is no longer payable (e.g. expired and cancelled): an admin decides.
      await flagMismatch(tx, { orderId: p.orderId, kind: "PAID_AFTER_CANCEL", expected: { state: "CREATED" }, actual: { state: payment.order.state, providerPaymentId: p.providerPaymentId, amount: p.amount } });
      return "flagged";
    }
    const { settings } = await getSettingsVersion(tx, payment.order.settingsVersion);
    await transitionOrder(tx, { orderId: p.orderId, event: "paymentSucceeded", actor: SYSTEM, payload: { providerPaymentId: p.providerPaymentId, source: p.source }, data: { autoReleaseAt: new Date(paidAt.getTime() + settings.orders.providerMaxHoldDays * DAY_MS) } });
    // §6.3 audit selection (M10): only orders without a Partner Check, only after payment, deterministic per order + settings version.
    if (!payment.order.inspectionReason && selectedForAudit(p.orderId, payment.order.settingsVersion, settings.inspections.auditPercent)) {
      await tx.order.update({ where: { id: p.orderId }, data: { inspectionReason: "AUDIT" } }); // fee stays ₹0
      await recordAudit(tx, { actor: { type: "SYSTEM", id: null }, action: "order.audit_selected", entity: { type: "Order", id: p.orderId }, after: { settingsVersion: payment.order.settingsVersion, auditPercent: settings.inspections.auditPercent } });
      await enqueueOutbox(tx, { queue: "notifications", name: "send", payload: { userId: payment.order.buyerId, channel: "IN_APP", type: "order.audit_selected", title: "Routine quality check", body: "This order was picked for a routine quality check", link: `/orders/${p.orderId}` } });
    }
    const sellerConfirmBy = new Date(Date.now() + settings.orders.sellerConfirmHours * HOUR_MS);
    await transitionOrder(tx, { orderId: p.orderId, event: "notifySeller", actor: { type: "SYSTEM", id: null }, data: { sellerConfirmBy } });
    await enqueueOutbox(tx, { queue: "orders", name: "sellerTimeout", payload: { orderId: p.orderId }, runAt: new Date(sellerConfirmBy.getTime() + 5_000) });
    return "paid";
  });
}

/**
 * Ask the provider how the order's payments went and apply a success (return page, expiry timer, admin).
 * Returns the RePart view after the check.
 */
export async function confirmFromProvider(db: Db, provider: PaymentProvider, orderId: string): Promise<{ state: string; paymentStatus: string | null }> {
  const payment = await db.payment.findUnique({ where: { orderId }, select: { id: true, status: true, provider: true } });
  if (payment && payment.provider === provider.name && payment.status !== "SUCCESS") {
    const attempts = await provider.getPayments(orderId);
    const success = attempts.find((a) => a.status === "SUCCESS");
    if (success) {
      await confirmPaid(db, { orderId, providerPaymentId: success.providerPaymentId, amount: success.amount, currency: "INR", at: success.at ?? new Date(), source: "poll", eventId: `poll:${success.providerPaymentId}` });
    } else if (attempts.some((a) => a.status === "PENDING") && payment.status === "CREATED") {
      await db.payment.update({ where: { id: payment.id }, data: { status: "PENDING" } });
    }
  }
  const o = await db.order.findUnique({ where: { id: orderId }, select: { state: true, payment: { select: { status: true } } } });
  return { state: o?.state ?? "UNKNOWN", paymentStatus: o?.payment?.status ?? null };
}

export type { Tx };

/**
 * Dev-only mock checkout (PLAN.md §7.3): the mock provider signs a webhook for the chosen outcome and it goes
 * through receivePaymentWebhook like any real one. The amount is the order's own total unless a test overrides it.
 */
export async function simulateMockPayment(db: Db, provider: PaymentProvider, buyerId: string, orderId: string, outcome: "SUCCESS" | "FAILED" | "USER_DROPPED") {
  if (provider.name !== "mock" || !("simulatePayment" in provider)) throw new Error("mock payments are only available with PAYMENT_PROVIDER=mock");
  const order = await db.order.findFirst({ where: { id: orderId, buyerId }, select: { totalPaise: true } });
  if (!order) throw new Error("order not found");
  const mock = provider as PaymentProvider & { simulatePayment(orderId: string, outcome: string, amount?: number): { rawBody: string; headers: Headers } };
  const { rawBody, headers } = mock.simulatePayment(orderId, outcome, order.totalPaise);
  return receivePaymentWebhook(db, provider, rawBody, headers);
}
