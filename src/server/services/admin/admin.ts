import "server-only";
import { z } from "zod";
import type { OrderState, Prisma, PrismaClient, ReportStatus, Role, UserStatus } from "@/generated/prisma/client";
import { FieldError, NotFoundError, UserError } from "../../http/errors";
import { recordAudit } from "../audit/audit";
import { nearAutoRelease } from "../order/disputes";
import { listingReviewQueue } from "../risk/review";

/**
 * M12 admin (PLAN.md §4.8, milestone 12): overview metrics, order search, reports, users and roles, the
 * agreement dashboard, the training-data export and the audit log viewer. Read models only, plus audited
 * moderation / role / status changes. No money logic.
 */
type Db = PrismaClient;
type Admin = { userId: string; requestId?: string };
const DAY_MS = 86_400_000;
export const PAGE_SIZE = 50;

const opt = z.string().trim().max(200).optional().transform((v) => v || undefined);
const date = z.string().trim().max(20).optional().transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined));
const range = (from?: string, to?: string) => (from || to ? { ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}), ...(to ? { lt: new Date(new Date(`${to}T00:00:00Z`).getTime() + DAY_MS) } : {}) } : undefined);
/** 10-digit Indian mobile → E.164 (+91…), so admins can search either way. */
const phoneOf = (q: string) => (/^\d{10}$/.test(q) ? `+91${q}` : q);
const page = z.coerce.number().int().min(1).max(10_000).optional().default(1);

// ── overview (current-state aggregates only) ──

export async function overviewMetrics(db: Db, now = new Date()) {
  const [orders, listings, openDisputes, refunded, pendingRefunds, mismatches, openMismatches, reviewQueue, near] = await Promise.all([
    db.order.groupBy({ by: ["state"], _count: { _all: true } }),
    db.listing.groupBy({ by: ["status"], _count: { _all: true } }),
    db.dispute.count({ where: { status: { in: ["OPEN", "AWAITING_SELLER", "UNDER_REVIEW"] } } }),
    db.refund.aggregate({ where: { status: "SUCCESS" }, _sum: { amountPaise: true }, _count: { _all: true } }),
    db.refund.count({ where: { status: { in: ["REQUESTED", "PENDING"] } } }),
    db.reconciliationMismatch.count({ where: { resolvedAt: null } }),
    db.reconciliationMismatch.findMany({ where: { resolvedAt: null }, orderBy: { id: "desc" }, take: 10, select: { id: true, kind: true, orderId: true, run: { select: { runDate: true } } } }),
    listingReviewQueue(db),
    nearAutoRelease(db, now),
  ]);
  return {
    ordersByState: orders.map((o) => ({ state: o.state, count: o._count._all })).sort((a, b) => b.count - a.count),
    listingsByStatus: listings.map((l) => ({ status: l.status, count: l._count._all })).sort((a, b) => b.count - a.count),
    openDisputes,
    reviewQueueCount: reviewQueue.length,
    refundedPaise: refunded._sum.amountPaise ?? 0,
    refundedCount: refunded._count._all,
    pendingRefunds,
    openMismatchCount: mismatches,
    openMismatches,
    nearAutoRelease: near,
  };
}

// ── orders ──

export const orderFilterInput = z.object({
  q: opt,
  state: opt,
  paymentStatus: opt,
  disputeStatus: opt,
  from: date,
  to: date,
  sort: z.enum(["newest", "oldest", "deadline"]).optional().default("newest"),
  page,
});

export async function searchOrders(db: Db, raw: unknown, now = new Date()) {
  const f = orderFilterInput.parse(raw ?? {});
  const where: Prisma.OrderWhereInput = {
    ...(f.q ? { OR: [{ id: f.q }, { buyerId: f.q }, { sellerId: f.q }, { buyer: { phone: phoneOf(f.q) } }, { seller: { phone: phoneOf(f.q) } }, { buyer: { email: f.q } }, { seller: { email: f.q } }] } : {}),
    ...(f.state ? { state: f.state as OrderState } : {}),
    ...(f.paymentStatus ? { payment: { status: f.paymentStatus as Prisma.EnumPaymentStatusFilter["equals"] } } : {}),
    ...(f.disputeStatus ? { dispute: { status: f.disputeStatus as Prisma.EnumDisputeStatusFilter["equals"] } } : {}),
    ...(range(f.from, f.to) ? { createdAt: range(f.from, f.to) } : {}),
  };
  const orderBy: Prisma.OrderOrderByWithRelationInput[] = f.sort === "oldest" ? [{ createdAt: "asc" }] : f.sort === "deadline" ? [{ autoReleaseAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }] : [{ createdAt: "desc" }];
  const [rows, total] = await Promise.all([
    db.order.findMany({
      where,
      orderBy,
      skip: (f.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, state: true, totalPaise: true, createdAt: true, autoReleaseAt: true, deadlineBreachedAt: true, listing: { select: { title: true, partName: true } }, payment: { select: { status: true, vendorSettlementStatus: true } }, dispute: { select: { status: true } } },
    }),
    db.order.count({ where }),
  ]);
  const terminal = ["COMPLETED", "RESOLVED_REFUND", "RESOLVED_RELEASE", "CANCELLED"];
  return { filter: f, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), rows: rows.map((o) => ({ ...o, nearDeadline: !!o.autoReleaseAt && !terminal.includes(o.state) && o.autoReleaseAt.getTime() - now.getTime() <= 7 * DAY_MS })) };
}

/** Event history and payment events for the admin order page (PLAN.md §4.8 "event history, payment events"). */
export async function orderHistory(db: Db, orderId: string) {
  const [events, paymentEvents] = await Promise.all([
    db.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: "asc" }, select: { id: true, fromState: true, toState: true, event: true, actorType: true, actorId: true, createdAt: true } }),
    db.paymentEvent.findMany({ where: { payment: { orderId } }, orderBy: { createdAt: "asc" }, select: { id: true, type: true, providerEventId: true, createdAt: true } }),
  ]);
  return { events, paymentEvents };
}

// ── reports ──

export const reportFilterInput = z.object({
  q: opt,
  status: z.enum(["OPEN", "ACTIONED", "DISMISSED", ""]).optional().transform((v) => v || undefined),
  targetType: z.enum(["LISTING", "USER", "MESSAGE", ""]).optional().transform((v) => v || undefined),
  reason: opt,
  from: date,
  to: date,
  page,
});

export async function listReports(db: Db, raw: unknown) {
  const f = reportFilterInput.parse(raw ?? {});
  const where: Prisma.ReportWhereInput = {
    ...(f.q ? { OR: [{ id: f.q }, { listingId: f.q }, { userId: f.q }, { messageId: f.q }] } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.targetType ? { targetType: f.targetType } : {}),
    ...(f.reason ? { reason: { contains: f.reason, mode: "insensitive" } } : {}),
    ...(range(f.from, f.to) ? { createdAt: range(f.from, f.to) } : {}),
  };
  const [rows, total] = await Promise.all([db.report.findMany({ where, orderBy: { createdAt: "desc" }, skip: (f.page - 1) * PAGE_SIZE, take: PAGE_SIZE }), db.report.count({ where })]);
  return { filter: f, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), rows: rows.map((r) => ({ ...r, targetId: r.listingId ?? r.userId ?? r.messageId })) };
}

/**
 * ACTIONED / DISMISSED: records who handled it and when, audited. "Actioned" never suspends a user or removes a
 * listing by itself: admins use the dedicated user and listing tools for that.
 */
export async function moderateReport(db: Db, admin: Admin, reportId: string, decision: "ACTIONED" | "DISMISSED", note?: string) {
  await db.$transaction(async (tx) => {
    const r = await tx.report.findUnique({ where: { id: reportId } });
    if (!r) throw new NotFoundError("report");
    if (r.status !== "OPEN") throw new UserError("This report was already handled.");
    const { count } = await tx.report.updateMany({ where: { id: reportId, status: "OPEN" }, data: { status: decision as ReportStatus, handledById: admin.userId, handledAt: new Date() } });
    if (!count) throw new UserError("This report was already handled.");
    await recordAudit(tx, { actor: { type: "ADMIN", id: admin.userId }, action: decision === "ACTIONED" ? "report.actioned" : "report.dismissed", entity: { type: "Report", id: reportId }, before: { status: "OPEN" }, after: { status: decision, targetType: r.targetType, ...(note ? { note: note.slice(0, 300) } : {}) }, requestId: admin.requestId });
  });
}

// ── users and roles ──

export const userFilterInput = z.object({
  q: opt,
  role: z.enum(["MEMBER", "MECHANIC", "ADMIN", ""]).optional().transform((v) => v || undefined),
  status: z.enum(["ACTIVE", "SUSPENDED", "DELETED", ""]).optional().transform((v) => v || undefined),
  sort: z.enum(["newest", "oldest"]).optional().default("newest"),
  page,
});

export async function listUsers(db: Db, raw: unknown) {
  const f = userFilterInput.parse(raw ?? {});
  const where: Prisma.UserWhereInput = {
    ...(f.q ? { OR: [{ id: f.q }, { phone: phoneOf(f.q) }, { phone: { contains: f.q } }, { email: { equals: f.q, mode: "insensitive" } }] } : {}),
    ...(f.role ? { roles: { has: f.role as Role } } : {}),
    ...(f.status ? { status: f.status as UserStatus } : {}),
  };
  const [rows, total] = await Promise.all([
    db.user.findMany({ where, orderBy: { createdAt: f.sort === "oldest" ? "asc" : "desc" }, skip: (f.page - 1) * PAGE_SIZE, take: PAGE_SIZE, select: { id: true, phone: true, email: true, name: true, roles: true, status: true, createdAt: true, isSample: true } }),
    db.user.count({ where }),
  ]);
  return { filter: f, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), rows };
}

export async function userDetail(db: Db, userId: string) {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true, phone: true, email: true, name: true, roles: true, status: true, createdAt: true, isSample: true,
      payoutAccount: { select: { status: true, providerVendorId: true } },
      mechanicStaff: { select: { active: true, partner: { select: { id: true, garageName: true } } } },
      _count: { select: { listings: true, buyerOrders: true, sellerOrders: true } },
    },
  });
  if (!u) throw new NotFoundError("user");
  const audit = await db.auditLog.findMany({ where: { OR: [{ entityType: "User", entityId: userId }, { actorId: userId }] }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, action: true, entityType: true, entityId: true, actorType: true, createdAt: true } });
  return { ...u, audit };
}

const MANAGED_ROLES = ["MECHANIC", "ADMIN"] as const;
export const roleChangeInput = z.object({ userId: z.string().min(1).max(64), role: z.enum(MANAGED_ROLES), grant: z.enum(["true", "false"]).transform((v) => v === "true") });

/** Another ACTIVE admin must remain, so the system can never lose its last admin. */
async function assertNotLastAdmin(tx: Prisma.TransactionClient, userId: string) {
  const others = await tx.user.count({ where: { roles: { has: "ADMIN" }, status: "ACTIVE", id: { not: userId } } });
  if (others === 0) throw new UserError("This is the only active admin. Make someone else an admin first.");
}

/** Grant or revoke MECHANIC / ADMIN (A-19), audited. The M10 garage link isn't touched; revoking MECHANIC closes the portal. */
export async function changeRole(db: Db, admin: Admin, raw: unknown) {
  const r = roleChangeInput.safeParse(raw);
  if (!r.success) throw new FieldError(Object.fromEntries(r.error.issues.map((i) => [String(i.path[0] ?? "form"), i.message])));
  const { userId, role, grant } = r.data;
  await db.$transaction(async (tx) => {
    // Serialise role/status changes so two admins can't remove each other's admin role at the same time.
    await tx.$queryRaw`SELECT id FROM "User" WHERE roles @> ARRAY['ADMIN']::"Role"[] ORDER BY id FOR UPDATE`;
    const u = await tx.user.findUnique({ where: { id: userId }, select: { roles: true } });
    if (!u) throw new NotFoundError("user");
    const has = u.roles.includes(role);
    if (has === grant) return; // already in that state: nothing to change or audit
    if (!grant && role === "ADMIN") await assertNotLastAdmin(tx, userId);
    const roles = grant ? [...u.roles, role] : u.roles.filter((x) => x !== role);
    await tx.user.update({ where: { id: userId }, data: { roles } });
    await recordAudit(tx, { actor: { type: "ADMIN", id: admin.userId }, action: grant ? "user.role_granted" : "user.role_revoked", entity: { type: "User", id: userId }, before: { roles: u.roles }, after: { roles, role }, requestId: admin.requestId });
  });
}

export const statusChangeInput = z.object({ userId: z.string().min(1).max(64), status: z.enum(["SUSPENDED", "ACTIVE"]), reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(300) });

/** Suspend / unsuspend, audited. Sessions of a suspended user are refused on every request (existing session check). */
export async function changeStatus(db: Db, admin: Admin, raw: unknown) {
  const r = statusChangeInput.safeParse(raw);
  if (!r.success) throw new FieldError(Object.fromEntries(r.error.issues.map((i) => [String(i.path[0] ?? "form"), i.message])));
  const { userId, status, reason } = r.data;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE roles @> ARRAY['ADMIN']::"Role"[] ORDER BY id FOR UPDATE`;
    const u = await tx.user.findUnique({ where: { id: userId }, select: { status: true, roles: true } });
    if (!u) throw new NotFoundError("user");
    if (u.status === "DELETED") throw new UserError("Deleted accounts can't be changed here.");
    if (u.status === status) return;
    if (status === "SUSPENDED" && u.roles.includes("ADMIN")) await assertNotLastAdmin(tx, userId);
    await tx.user.update({ where: { id: userId }, data: { status } });
    await recordAudit(tx, { actor: { type: "ADMIN", id: admin.userId }, action: status === "SUSPENDED" ? "user.suspended" : "user.unsuspended", entity: { type: "User", id: userId }, before: { status: u.status }, after: { status, reason }, requestId: admin.requestId });
  });
}

// ── agreement dashboard ──

export type AgreementInput = { category: string; automatedPass: boolean | null; mechanicOutcome: "PASS" | "PASS_WITH_NOTES" | "FAIL" };
export type AgreementRow = {
  category: string;
  inspected: number;
  automatedPass: number;
  automatedNonPass: number;
  unassessed: number;
  mechanicPass: number;
  mechanicFail: number;
  falsePass: number;
  falsePassRate: number;
};

/**
 * Automated decision vs mechanic outcome (PLAN.md milestone 12). PASS_WITH_NOTES counts as a mechanic pass.
 * false-pass rate = (automated pass AND mechanic FAIL) ÷ all inspected listings; 0 when nothing was inspected.
 * Listings without a stored risk assessment are counted as "unassessed", never guessed.
 */
export function computeAgreement(rows: AgreementInput[]): { byCategory: AgreementRow[]; total: AgreementRow } {
  const blank = (category: string): AgreementRow => ({ category, inspected: 0, automatedPass: 0, automatedNonPass: 0, unassessed: 0, mechanicPass: 0, mechanicFail: 0, falsePass: 0, falsePassRate: 0 });
  const groups = new Map<string, AgreementRow>();
  const total = blank("All categories");
  for (const r of rows) {
    const g = groups.get(r.category) ?? blank(r.category);
    groups.set(r.category, g);
    for (const t of [g, total]) {
      t.inspected++;
      if (r.automatedPass === null) t.unassessed++;
      else if (r.automatedPass) t.automatedPass++;
      else t.automatedNonPass++;
      if (r.mechanicOutcome === "FAIL") t.mechanicFail++;
      else t.mechanicPass++;
      if (r.automatedPass === true && r.mechanicOutcome === "FAIL") t.falsePass++;
    }
  }
  const rate = (t: AgreementRow) => ({ ...t, falsePassRate: t.inspected ? t.falsePass / t.inspected : 0 });
  return { byCategory: [...groups.values()].map(rate).sort((a, b) => a.category.localeCompare(b.category)), total: rate(total) };
}

/** Automated pass: the stored assessment routed LIVE with no hard failure, no failed rule and no admin-review flag. */
export function isAutomatedPass(ra: { routingDecision: string; hadHardFailure: boolean; reasons: unknown; checkResults: unknown }) {
  const reasons = Array.isArray(ra.reasons) ? ra.reasons : [];
  const review = !!(ra.checkResults && typeof ra.checkResults === "object" && (ra.checkResults as { needsAdminReview?: boolean }).needsAdminReview);
  return ra.routingDecision === "LIVE" && !ra.hadHardFailure && reasons.length === 0 && !review;
}

/** One row per inspected listing: its latest completed inspection (any reason: required, optional, audit) and latest assessment. */
export async function agreementData(db: Db, opts: { includeSample?: boolean } = {}) {
  const inspections = await db.inspection.findMany({
    where: { status: "COMPLETED", outcome: { not: null }, ...(opts.includeSample ? {} : { listing: { isSample: false } }) },
    orderBy: { completedAt: "desc" },
    select: { listingId: true, outcome: true, listing: { select: { category: { select: { name: true } }, riskAssessments: { orderBy: { createdAt: "desc" }, take: 1, select: { routingDecision: true, hadHardFailure: true, reasons: true, checkResults: true } } } } },
  });
  const seen = new Set<string>();
  const rows: AgreementInput[] = [];
  for (const i of inspections) {
    if (seen.has(i.listingId)) continue;
    seen.add(i.listingId);
    const ra = i.listing.riskAssessments[0];
    rows.push({ category: i.listing.category?.name ?? "Uncategorised", automatedPass: ra ? isAutomatedPass(ra) : null, mechanicOutcome: i.outcome! });
  }
  return computeAgreement(rows);
}

// ── training-data export (streamed CSV, one row per listing) ──

/** The fixed column contract. Order and names are tested; add new columns only at the end. */
export const EXPORT_COLUMNS = [
  "listing_id",
  "listing_status",
  "listing_created_at",
  "category_slug",
  "category_name",
  "part_number_id",
  "part_number_entered",
  "condition_grade",
  "condition_score",
  "price_paise",
  "trust_label",
  "inspection_requirement",
  "photo_count",
  "photo_storage_keys",
  "photo_shot_types",
  "photo_widths",
  "photo_heights",
  "photo_blur_scores",
  "photo_brightness_scores",
  "photo_phashes",
  "risk_assessment_id",
  "risk_assessed_at",
  "risk_score",
  "risk_reasons",
  "risk_routing",
  "risk_hard_failure",
  "risk_rule_set_version",
  "risk_vision_model_version",
  "risk_needs_admin_review",
  "inspection_id",
  "inspection_reason",
  "inspection_outcome",
  "inspection_completed_at",
  "inspection_notes",
  "order_id",
  "order_state",
  "order_outcome",
  "dispute_reason",
  "fitment_count",
  "fitment_variant_ids",
  "fitment_confirmation_count",
  "fitment_flagged_count",
  "is_sample",
] as const;

/** RFC 4180 quoting, plus a leading apostrophe on values a spreadsheet would run as a formula. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: unknown[]) => `${cells.map(csvCell).join(",")}\r\n`;
const joined = (xs: unknown[]) => (xs.length ? xs.map((x) => (x === null || x === undefined ? "" : String(x))).join("|") : null);

const OUTCOME: Record<string, string> = { COMPLETED: "completed", RESOLVED_RELEASE: "completed", CANCELLED: "cancelled", DISPUTED: "disputed", RESOLVED_REFUND: "disputed" };

const exportSelect = {
  id: true, status: true, createdAt: true, partNumberId: true, partNumberEntered: true, conditionGrade: true, conditionScore: true, pricePaise: true, trustLabel: true, inspectionRequirement: true, isSample: true,
  category: { select: { slug: true, name: true } },
  photos: { orderBy: { sortOrder: "asc" as const }, select: { storageKey: true, shotType: true, width: true, height: true, blurScore: true, brightnessScore: true, pHash: true } },
  riskAssessments: { orderBy: { createdAt: "desc" as const }, take: 1, select: { id: true, createdAt: true, score: true, reasons: true, routingDecision: true, hadHardFailure: true, ruleSetVersion: true, visionModelVersion: true, checkResults: true } },
  inspections: { where: { status: "COMPLETED" as const }, orderBy: { completedAt: "desc" as const }, take: 1, select: { id: true, reason: true, outcome: true, completedAt: true, notes: true } },
  orders: { orderBy: { createdAt: "desc" as const }, take: 1, select: { id: true, state: true, dispute: { select: { reason: true } } } },
  fitments: { select: { variantId: true, confirmationCount: true, flaggedCount: true } },
} satisfies Prisma.ListingSelect;
type ExportListing = Prisma.ListingGetPayload<{ select: typeof exportSelect }>;

export function exportRow(l: ExportListing): unknown[] {
  const ra = l.riskAssessments[0];
  const insp = l.inspections[0];
  const order = l.orders[0];
  const reasons = ra && Array.isArray(ra.reasons) ? (ra.reasons as Array<{ code?: string }>).map((r) => r.code ?? "") : [];
  const values: Record<(typeof EXPORT_COLUMNS)[number], unknown> = {
    listing_id: l.id,
    listing_status: l.status,
    listing_created_at: l.createdAt,
    category_slug: l.category?.slug,
    category_name: l.category?.name,
    part_number_id: l.partNumberId,
    part_number_entered: l.partNumberEntered,
    condition_grade: l.conditionGrade,
    condition_score: l.conditionScore,
    price_paise: l.pricePaise,
    trust_label: l.trustLabel,
    inspection_requirement: l.inspectionRequirement,
    photo_count: l.photos.length,
    photo_storage_keys: joined(l.photos.map((p) => p.storageKey)),
    photo_shot_types: joined(l.photos.map((p) => p.shotType)),
    photo_widths: joined(l.photos.map((p) => p.width)),
    photo_heights: joined(l.photos.map((p) => p.height)),
    photo_blur_scores: joined(l.photos.map((p) => p.blurScore)),
    photo_brightness_scores: joined(l.photos.map((p) => p.brightnessScore)),
    photo_phashes: joined(l.photos.map((p) => p.pHash)),
    risk_assessment_id: ra?.id,
    risk_assessed_at: ra?.createdAt,
    risk_score: ra?.score,
    risk_reasons: ra ? joined(reasons) : null,
    risk_routing: ra?.routingDecision,
    risk_hard_failure: ra ? ra.hadHardFailure : null,
    risk_rule_set_version: ra?.ruleSetVersion,
    risk_vision_model_version: ra?.visionModelVersion,
    risk_needs_admin_review: ra ? !!(ra.checkResults as { needsAdminReview?: boolean } | null)?.needsAdminReview : null,
    inspection_id: insp?.id,
    inspection_reason: insp?.reason,
    inspection_outcome: insp?.outcome,
    inspection_completed_at: insp?.completedAt,
    inspection_notes: insp?.notes,
    order_id: order?.id,
    order_state: order?.state,
    order_outcome: order ? (OUTCOME[order.state] ?? "in_progress") : null,
    dispute_reason: order?.dispute?.reason,
    fitment_count: l.fitments.length,
    fitment_variant_ids: joined(l.fitments.map((f) => f.variantId)),
    fitment_confirmation_count: l.fitments.reduce((s, f) => s + f.confirmationCount, 0),
    fitment_flagged_count: l.fitments.reduce((s, f) => s + f.flaggedCount, 0),
    is_sample: l.isSample,
  };
  return EXPORT_COLUMNS.map((c) => values[c]);
}

/** Streams the CSV in batches (never the whole export in memory). Drafts are excluded: they carry no decisions. */
export function trainingCsvStream(db: Db, opts: { includeSample: boolean; batchSize?: number }): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const where: Prisma.ListingWhereInput = { status: { not: "DRAFT" }, ...(opts.includeSample ? {} : { isSample: false }) };
  let cursor: string | undefined;
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(enc.encode(csvLine([...EXPORT_COLUMNS])));
        return;
      }
      const batch = await db.listing.findMany({ where, orderBy: { id: "asc" }, take: opts.batchSize ?? 200, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), select: exportSelect });
      if (!batch.length) return controller.close();
      cursor = batch[batch.length - 1]!.id;
      controller.enqueue(enc.encode(batch.map((l) => csvLine(exportRow(l))).join("")));
    },
  });
}

export async function auditExport(db: Db, admin: Admin, opts: { includeSample: boolean }) {
  await db.$transaction((tx) =>
    recordAudit(tx, { actor: { type: "ADMIN", id: admin.userId }, action: "export.training_data", entity: { type: "Export", id: `training-${new Date().toISOString()}` }, after: { dataset: "training.csv", granularity: "listing", includeSample: opts.includeSample, columns: EXPORT_COLUMNS.length }, requestId: admin.requestId }),
  );
}

// ── audit log viewer (read-only) ──

export const auditFilterInput = z.object({ actor: opt, action: opt, entityType: opt, entityId: opt, from: date, to: date, page });

export async function listAudit(db: Db, raw: unknown) {
  const f = auditFilterInput.parse(raw ?? {});
  const where: Prisma.AuditLogWhereInput = {
    ...(f.actor ? { actorId: f.actor } : {}),
    ...(f.action ? { action: { contains: f.action } } : {}),
    ...(f.entityType ? { entityType: f.entityType } : {}),
    ...(f.entityId ? { entityId: f.entityId } : {}),
    ...(range(f.from, f.to) ? { createdAt: range(f.from, f.to) } : {}),
  };
  const [rows, total] = await Promise.all([db.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (f.page - 1) * PAGE_SIZE, take: PAGE_SIZE }), db.auditLog.count({ where })]);
  return { filter: f, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), rows };
}
