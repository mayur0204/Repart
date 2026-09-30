import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { createMockPaymentProvider, signMockWebhook } from "../../src/server/adapters/payment/mock";
import type { PaymentProvider } from "../../src/server/adapters/payment/types";
import { createMockShippingProvider } from "../../src/server/adapters/shipping/mock";
import { createSession, resolveSession } from "../../src/server/auth/session";
import { UserError } from "../../src/server/http/errors";
import {
  agreementData,
  changeRole,
  changeStatus,
  EXPORT_COLUMNS,
  listAudit,
  listReports,
  listUsers,
  moderateReport,
  orderHistory,
  overviewMetrics,
  PAGE_SIZE,
  searchOrders,
  trainingCsvStream,
  userDetail,
} from "../../src/server/services/admin/admin";
import { payOrder, placeOrder } from "../../src/server/services/order/checkout";
import { receivePaymentWebhook } from "../../src/server/services/payment/payment-events";
import { noAuditVersion, removeSettingsFixtures } from "../setup/settings-fixtures";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const ADMIN = { userId: "sample-user-admin" };
const SECRET = "test-webhook-secret-0123456789";
const shipping = createMockShippingProvider({ webhookSecret: "ship-secret-0123456789" });
const payment = { ...createMockPaymentProvider({ webhookSecret: SECRET, baseUrl: "http://x" }), name: "fake", createOrder: async (i: Parameters<PaymentProvider["createOrder"]>[0]) => ({ providerOrderId: `cf_${i.orderId}`, status: "CREATED" as const, checkoutUrl: null, paymentSessionId: "s", amount: i.amount }) } as PaymentProvider;

async function listing(over: Record<string, unknown> = {}) {
  const s = await db.listing.findUniqueOrThrow({ where: { id: "sample-listing-live-tier-a" } });
  const { checklistAnswers, ...rest } = s;
  for (const k of ["id", "createdAt", "updatedAt"] as const) delete (rest as Partial<typeof s>)[k];
  const id = `test-ad-${randomUUID()}`;
  await db.listing.create({ data: { ...rest, id, status: "LIVE", version: 0, isSample: false, checklistAnswers: checklistAnswers ?? Prisma.JsonNull, ...over } as Prisma.ListingUncheckedCreateInput });
  return id;
}

async function paidOrder() {
  const listingId = await listing();
  const { orderId } = await placeOrder(db, { shipping, payment }, { userId: "sample-user-buyer" }, { listingId, addressId: "sample-addr-buyer" });
  await db.order.update({ where: { id: orderId }, data: { settingsVersion: await noAuditVersion(db) } });
  await payOrder(db, { shipping, payment }, { userId: "sample-user-buyer" }, orderId, "http://x");
  const total = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalPaise;
  const body = JSON.stringify({ providerEventId: `evt_${randomUUID()}`, type: "PAYMENT_SUCCESS", providerType: "TEST", orderId, providerPaymentId: `p_${orderId}`, amount: total, currency: "INR" });
  await receivePaymentWebhook(db, payment, body, signMockWebhook(SECRET, body, Date.now()));
  return { orderId, listingId };
}

const ra = (listingId: string, pass: boolean, extra: Partial<Prisma.RiskAssessmentUncheckedCreateInput> = {}) =>
  db.riskAssessment.create({ data: { listingId, score: pass ? 5 : 70, reasons: pass ? [] : [{ code: "PRICE_OUTLIER", severity: "SOFT" }], checkResults: { needsAdminReview: !pass }, hadHardFailure: false, ruleSetVersion: 1, routingDecision: "LIVE", ...extra } });
const inspect = (listingId: string, outcome: "PASS" | "PASS_WITH_NOTES" | "FAIL", reason: "TIER_C" | "AUDIT" | "BUYER_OPTIONAL", completedAt = new Date()) =>
  db.inspection.create({ data: { listingId, partnerId: "sample-garage-partner", reason, status: "COMPLETED", outcome, completedAt, notes: outcome === "FAIL" ? "Cracked, mounting tab missing" : null } });

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  let chunks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks++;
    text += dec.decode(value);
  }
  return { text, chunks, lines: text.split("\r\n").filter(Boolean) };
}

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
afterAll(async () => {
  await removeSettingsFixtures(db);
  await db.$disconnect();
});

describe("overview", () => {
  it("reports current-state metrics from real data, including open reconciliation mismatches", async () => {
    const before = await overviewMetrics(db);
    const run = await db.reconciliationRun.create({ data: { runDate: new Date(), status: "COMPLETED" } });
    await db.reconciliationMismatch.create({ data: { runId: run.id, kind: "AMOUNT_MISMATCH", orderId: null } });
    const after = await overviewMetrics(db);
    expect(after.openMismatchCount).toBe(before.openMismatchCount + 1);
    expect(after.openMismatches[0]!.kind).toBe("AMOUNT_MISMATCH");
    expect(after.ordersByState.reduce((s, o) => s + o.count, 0)).toBe(await db.order.count());
    expect(after.listingsByStatus.reduce((s, l) => s + l.count, 0)).toBe(await db.listing.count());
    expect(after.openDisputes).toBe(await db.dispute.count({ where: { status: { in: ["OPEN", "AWAITING_SELLER", "UNDER_REVIEW"] } } }));
    expect(after.nearAutoRelease).toHaveProperty("disputes"); // the M11 near-deadline panels still come through
    expect(typeof after.refundedPaise).toBe("number");
  });
});

describe("orders", () => {
  it("searches by order id, buyer phone and email; filters by state, payment, dispute and dates; sorts", async () => {
    const { orderId } = await paidOrder();
    expect((await searchOrders(db, { q: orderId })).rows.map((r) => r.id)).toEqual([orderId]);
    const buyer = await db.user.findUniqueOrThrow({ where: { id: "sample-user-buyer" } });
    expect((await searchOrders(db, { q: buyer.phone.replace("+91", "") })).rows.map((r) => r.id)).toContain(orderId);
    expect((await searchOrders(db, { q: "sample-user-buyer", state: "AWAITING_SELLER" })).rows.map((r) => r.id)).toContain(orderId);
    expect((await searchOrders(db, { q: orderId, state: "COMPLETED" })).rows).toHaveLength(0);
    expect((await searchOrders(db, { q: orderId, paymentStatus: "SUCCESS" })).rows).toHaveLength(1);
    expect((await searchOrders(db, { q: orderId, disputeStatus: "OPEN" })).rows).toHaveLength(0);
    const today = new Date().toISOString().slice(0, 10);
    expect((await searchOrders(db, { q: orderId, from: today, to: today })).rows).toHaveLength(1);
    expect((await searchOrders(db, { q: orderId, from: "2000-01-01", to: "2000-01-02" })).rows).toHaveLength(0);
    const newest = await searchOrders(db, { sort: "newest" });
    const oldest = await searchOrders(db, { sort: "oldest" });
    expect(newest.rows[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(oldest.rows[0]!.createdAt.getTime());
    const byDeadline = (await searchOrders(db, { sort: "deadline" })).rows.filter((r) => r.autoReleaseAt).map((r) => r.autoReleaseAt!.getTime());
    expect(byDeadline).toEqual([...byDeadline].sort((a, b) => a - b));
  });

  it("the order history shows its events and payment events", async () => {
    const { orderId } = await paidOrder();
    const h = await orderHistory(db, orderId);
    expect(h.events.map((e) => e.toState)).toEqual(["CREATED", "PAID_HELD", "AWAITING_SELLER"]);
    expect(h.paymentEvents.map((e) => e.type)).toContain("PAYMENT_SUCCESS_WEBHOOK");
  });
});

describe("reports", () => {
  it("lists with filters; actioned / dismissed record who and when, are audited, and enforce nothing", async () => {
    const listingId = await listing();
    const target = await db.user.create({ data: { phone: `+917${String(Date.now()).slice(-9)}`, name: "Reported User" } });
    const r1 = await db.report.create({ data: { reporterId: "sample-user-buyer", targetType: "LISTING", listingId, reason: "Looks stolen", details: "Serial scratched off" } });
    const r2 = await db.report.create({ data: { reporterId: "sample-user-buyer", targetType: "USER", userId: target.id, reason: "Rude messages" } });
    expect((await listReports(db, { q: listingId })).rows.map((r) => r.id)).toEqual([r1.id]);
    expect((await listReports(db, { q: r2.id, targetType: "USER", status: "OPEN" })).rows[0]).toMatchObject({ id: r2.id, targetId: target.id });
    expect((await listReports(db, { q: r1.id, reason: "stolen" })).rows).toHaveLength(1);
    expect((await listReports(db, { q: r1.id, reason: "unrelated" })).rows).toHaveLength(0);

    await moderateReport(db, ADMIN, r1.id, "ACTIONED", "Asked the seller for proof");
    await moderateReport(db, ADMIN, r2.id, "DISMISSED");
    expect(await db.report.findUniqueOrThrow({ where: { id: r1.id } })).toMatchObject({ status: "ACTIONED", handledById: ADMIN.userId });
    expect((await db.report.findUniqueOrThrow({ where: { id: r2.id } })).handledAt).not.toBeNull();
    await expect(moderateReport(db, ADMIN, r1.id, "DISMISSED")).rejects.toBeInstanceOf(UserError);
    expect(await db.auditLog.count({ where: { entityId: r1.id, action: "report.actioned", actorId: ADMIN.userId } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: r2.id, action: "report.dismissed" } })).toBe(1);
    // "Actioned" doesn't take anything down or suspend anyone by itself.
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("LIVE");
    expect((await db.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("ACTIVE");
  });
});

describe("users and roles", () => {
  it("search, filters, grant/revoke roles and suspend/unsuspend, all audited; suspended sessions are refused", async () => {
    const phone = `+916${String(Date.now()).slice(-9)}`;
    const u = await db.user.create({ data: { phone, email: `u${Date.now()}@example.com`, name: "Test Person" } });
    expect((await listUsers(db, { q: phone.slice(3) })).rows.map((r) => r.id)).toEqual([u.id]);
    expect((await listUsers(db, { q: u.email! })).rows.map((r) => r.id)).toEqual([u.id]);
    expect((await listUsers(db, { q: u.id, role: "ADMIN" })).rows).toHaveLength(0);

    await changeRole(db, ADMIN, { userId: u.id, role: "MECHANIC", grant: "true" });
    await changeRole(db, ADMIN, { userId: u.id, role: "ADMIN", grant: "true" });
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).roles).toEqual(expect.arrayContaining(["MEMBER", "MECHANIC", "ADMIN"]));
    expect((await listUsers(db, { q: u.id, role: "ADMIN" })).rows).toHaveLength(1);
    await changeRole(db, ADMIN, { userId: u.id, role: "MECHANIC", grant: "false" });
    await changeRole(db, ADMIN, { userId: u.id, role: "ADMIN", grant: "false" });
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).roles).toEqual(["MEMBER"]);
    expect(await db.auditLog.count({ where: { entityId: u.id, action: { in: ["user.role_granted", "user.role_revoked"] } } })).toBe(4);

    const { token } = await createSession(db, u.id);
    expect(await resolveSession(db, token)).not.toBeNull();
    await expect(changeStatus(db, ADMIN, { userId: u.id, status: "SUSPENDED", reason: "" })).rejects.toThrow();
    await changeStatus(db, ADMIN, { userId: u.id, status: "SUSPENDED", reason: "Repeated abuse reports" });
    expect(await resolveSession(db, token)).toBeNull(); // existing session check refuses suspended users
    expect((await listUsers(db, { q: u.id, status: "SUSPENDED" })).rows).toHaveLength(1);
    await changeStatus(db, ADMIN, { userId: u.id, status: "ACTIVE", reason: "Appeal accepted" });
    expect(await resolveSession(db, token)).not.toBeNull();
    expect(await db.auditLog.count({ where: { entityId: u.id, action: { in: ["user.suspended", "user.unsuspended"] } } })).toBe(2);
    const detail = await userDetail(db, u.id);
    expect(detail.audit.length).toBeGreaterThanOrEqual(6);
  });

  it("the last active admin can't lose the role or be suspended", async () => {
    const others = await db.user.findMany({ where: { roles: { has: "ADMIN" }, status: "ACTIVE", id: { not: ADMIN.userId } }, select: { id: true } });
    await db.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: "SUSPENDED" } });
    try {
      await expect(changeRole(db, ADMIN, { userId: ADMIN.userId, role: "ADMIN", grant: "false" })).rejects.toThrow(/only active admin/);
      await expect(changeStatus(db, ADMIN, { userId: ADMIN.userId, status: "SUSPENDED", reason: "Testing the guard" })).rejects.toThrow(/only active admin/);
      expect((await db.user.findUniqueOrThrow({ where: { id: ADMIN.userId } })).roles).toContain("ADMIN");
    } finally {
      await db.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: "ACTIVE" } });
    }
  });
});

describe("agreement dashboard", () => {
  it("counts from stored assessments and inspections: false pass, PASS_WITH_NOTES, audit/optional checks, latest inspection", async () => {
    const before = await agreementData(db);
    const cat = (await db.listing.findUniqueOrThrow({ where: { id: "sample-listing-live-tier-a" }, include: { category: true } })).category!.name;
    const a = await listing();
    await ra(a, true);
    await inspect(a, "FAIL", "TIER_C"); // automated pass + mechanic fail → false pass
    const b = await listing();
    await ra(b, false);
    await inspect(b, "PASS_WITH_NOTES", "BUYER_OPTIONAL"); // non-pass + mechanic pass
    const c = await listing();
    await ra(c, true);
    await inspect(c, "FAIL", "TIER_C", new Date(Date.now() - 86_400_000));
    await inspect(c, "PASS", "AUDIT"); // the latest inspection counts
    const d = await listing(); // inspected but never assessed: counted as not assessed
    await inspect(d, "PASS", "TIER_C");
    const after = await agreementData(db);
    const row = (x: typeof after, name: string) => x.byCategory.find((r) => r.category === name) ?? { inspected: 0, automatedPass: 0, automatedNonPass: 0, unassessed: 0, mechanicPass: 0, mechanicFail: 0, falsePass: 0 };
    const b0 = row(before, cat);
    const a1 = row(after, cat);
    expect({
      inspected: a1.inspected - b0.inspected,
      automatedPass: a1.automatedPass - b0.automatedPass,
      automatedNonPass: a1.automatedNonPass - b0.automatedNonPass,
      unassessed: a1.unassessed - b0.unassessed,
      mechanicPass: a1.mechanicPass - b0.mechanicPass,
      mechanicFail: a1.mechanicFail - b0.mechanicFail,
      falsePass: a1.falsePass - b0.falsePass,
    }).toEqual({ inspected: 4, automatedPass: 2, automatedNonPass: 1, unassessed: 1, mechanicPass: 3, mechanicFail: 1, falsePass: 1 });
    expect(after.total.falsePassRate).toBeCloseTo(after.total.falsePass / after.total.inspected);
    // Sample data is excluded by default.
    const withSamples = await agreementData(db, { includeSample: true });
    expect(withSamples.total.inspected).toBeGreaterThanOrEqual(after.total.inspected);
  });
});

describe("training-data export", () => {
  it("streams one row per listing in the fixed column order; sample data only when asked; empty cells for missing values", async () => {
    const id = await listing();
    await ra(id, true);
    await inspect(id, "PASS_WITH_NOTES", "AUDIT");
    await db.listingPhoto.create({ data: { listingId: id, shotType: "front", sortOrder: 0, storageKey: `listings/${id}/p1.jpg`, width: 800, height: 600, blurScore: 150.5, brightnessScore: 120, pHash: "abcd", processedAt: new Date() } });

    const out = await readAll(trainingCsvStream(db, { includeSample: false, batchSize: 2 }));
    expect(out.lines[0]).toBe(EXPORT_COLUMNS.join(","));
    expect(out.chunks).toBeGreaterThan(2); // header + several batches: streamed, not built in one piece
    // is_sample is the last column; a plain split would break on quoted commas in other rows' notes.
    expect(out.lines.slice(1).every((l) => l.endsWith(",false"))).toBe(true);
    const rows = out.lines.slice(1).map((l) => l.split(","));
    expect(out.text).not.toContain("sample-listing-live-tier-a");
    const mine = rows.find((r) => r[0] === id)!;
    const col = (name: (typeof EXPORT_COLUMNS)[number]) => mine[EXPORT_COLUMNS.indexOf(name)];
    expect(mine).toHaveLength(EXPORT_COLUMNS.length);
    expect(col("photo_count")).toBe("1");
    expect(col("photo_storage_keys")).toBe(`listings/${id}/p1.jpg`);
    expect(col("photo_blur_scores")).toBe("150.5");
    expect(col("risk_routing")).toBe("LIVE");
    expect(col("risk_needs_admin_review")).toBe("false");
    expect(col("inspection_outcome")).toBe("PASS_WITH_NOTES");
    expect(col("inspection_reason")).toBe("AUDIT");
    expect(col("order_id")).toBe(""); // never ordered: empty, not invented
    expect(col("order_outcome")).toBe("");
    expect(out.text).not.toMatch(/https?:\/\/|memory:\/\/|token=/); // storage keys only, never signed URLs

    const all = await readAll(trainingCsvStream(db, { includeSample: true }));
    expect(all.text).toContain("sample-listing-live-tier-a");
    expect(all.lines.length).toBeGreaterThan(out.lines.length);
  });
});

describe("audit log viewer", () => {
  it("filters by actor, action, entity and dates, newest first, in bounded pages; the log itself can't be edited", async () => {
    const u = await db.user.create({ data: { phone: `+915${String(Date.now()).slice(-9)}`, name: "Audited" } });
    await changeRole(db, ADMIN, { userId: u.id, role: "MECHANIC", grant: "true" });
    await changeRole(db, ADMIN, { userId: u.id, role: "MECHANIC", grant: "false" });
    const mine = await listAudit(db, { entityType: "User", entityId: u.id });
    expect(mine.rows.map((r) => r.action)).toEqual(["user.role_revoked", "user.role_granted"]);
    expect((await listAudit(db, { actor: ADMIN.userId, action: "role_granted", entityId: u.id })).rows).toHaveLength(1);
    expect((await listAudit(db, { entityId: u.id, from: "2000-01-01", to: "2000-01-02" })).rows).toHaveLength(0);
    const p1 = await listAudit(db, {});
    expect(p1.rows.length).toBeLessThanOrEqual(PAGE_SIZE);
    if (p1.total > PAGE_SIZE) {
      const p2 = await listAudit(db, { page: "2" });
      expect(p2.rows[0]!.id).not.toBe(p1.rows[0]!.id);
    }
    await expect(db.auditLog.update({ where: { id: mine.rows[0]!.id }, data: { action: "tampered" } })).rejects.toThrow();
  });
});
