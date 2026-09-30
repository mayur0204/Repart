import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type InspectionOutcome, type PrismaClient, type TrustLabel } from "@/generated/prisma/client";
import { MAX_PHOTO_BYTES } from "@/lib/listing";
import type { ShippingProvider } from "../../adapters/shipping/types";
import type { StorageProvider } from "../../adapters/storage/types";
import { FieldError, ForbiddenError, NotFoundError, UserError } from "../../http/errors";
import { logger } from "../../logger";
import { recordAudit } from "../audit/audit";
import { cleanPhoto } from "../listing/photos";
import { afterInspectionPassed, pickupSlots, resolveSlot, type PickupSlot } from "../order/fulfilment";
import { transitionOrder } from "../order/state";
import { enqueueOutbox } from "../outbox/outbox";
import { refundableComponents, requestRefund } from "../payment/refunds";
import { trustLabel } from "../risk/rules";
import { getActiveSettings } from "../settings/settings";

/**
 * Partner Checks (M10; PLAN.md §5.2 O5, O10, O11; §6.2–§6.4). Slots reuse the M9 catalogue (next 3 business
 * days, four 2-hour windows, IST). A garage is assigned deterministically among active garages serving the
 * seller's pincode with capacity left that day: lowest load, then highest on-time rate, then lowest fail rate,
 * then id. Capacity holds under concurrency because assignment locks the candidate garage rows.
 */
type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Actor = { userId: string; requestId?: string };
export type InspectionDeps = { storage: StorageProvider; bucket: string; listingBucket: string; shipping: ShippingProvider };

const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
const OPEN = ["PENDING_SLOT", "SCHEDULED"] as const;
const COUNTED = ["PENDING_SLOT", "SCHEDULED", "COMPLETED", "NO_SHOW"] as const; // everything that used (or uses) a slot
const VIEW_TTL_SECONDS = 600;
const UPLOAD_TTL_SECONDS = 300;

/** The IST calendar day containing `t`, as [start, end) instants. */
export function istDay(t: Date): [Date, Date] {
  const ist = new Date(t.getTime() + IST_MS);
  const start = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_MS;
  return [new Date(start), new Date(start + DAY_MS)];
}

// ── coverage, capacity, assignment ──

export async function hasCoverage(db: Pick<Db, "mechanicPartner">, pincode: string | null | undefined): Promise<boolean> {
  if (!pincode) return false;
  return (await db.mechanicPartner.count({ where: { active: true, servicePincodes: { has: pincode } } })) > 0;
}

type Candidate = { id: string; garageName: string; capacityPerDay: number; onTimeRate: number | null; failRate: number | null; load: number };

/** Eligible garages for a pincode and slot day, best first. `lock` takes row locks so concurrent assignments serialise. */
export async function rankGarages(tx: Pick<Tx, "mechanicPartner" | "inspection" | "$queryRaw">, pincode: string, slotStart: Date, opts: { lock?: boolean; exclude?: string } = {}): Promise<Candidate[]> {
  const partners = await tx.mechanicPartner.findMany({
    where: { active: true, servicePincodes: { has: pincode }, ...(opts.exclude ? { id: { not: opts.exclude } } : {}) },
    select: { id: true, garageName: true, capacityPerDay: true, onTimeRate: true, failRate: true },
  });
  if (!partners.length) return [];
  if (opts.lock) await tx.$queryRaw`SELECT id FROM "MechanicPartner" WHERE id = ANY(${partners.map((p) => p.id)}) ORDER BY id FOR UPDATE`;
  const [from, to] = istDay(slotStart);
  const loads = await tx.inspection.groupBy({ by: ["partnerId"], where: { partnerId: { in: partners.map((p) => p.id) }, status: { in: [...COUNTED] }, slotStart: { gte: from, lt: to } }, _count: { _all: true } });
  const load = new Map(loads.map((l) => [l.partnerId, l._count._all]));
  return partners
    .map((p) => ({ ...p, load: load.get(p.id) ?? 0 }))
    .filter((p) => p.load < p.capacityPerDay)
    .sort((a, b) => a.load - b.load || (b.onTimeRate ?? 0) - (a.onTimeRate ?? 0) || (a.failRate ?? 0) - (b.failRate ?? 0) || a.id.localeCompare(b.id));
}

/** Slots the seller may pick: the M9 catalogue, limited to days where some garage still has capacity (PLAN.md §6.4). */
export async function inspectionSlots(db: Db, pincode: string | null | undefined, now = new Date()): Promise<PickupSlot[]> {
  if (!pincode) return [];
  const slots = pickupSlots(now);
  const open = new Map<string, boolean>();
  const out: PickupSlot[] = [];
  for (const s of slots) {
    const day = istDay(s.start)[0].toISOString();
    if (!open.has(day)) open.set(day, (await rankGarages(db, pincode, s.start)).length > 0);
    if (open.get(day)) out.push(s);
  }
  return out;
}

async function staffOf(tx: Pick<Tx, "mechanicStaff">, partnerId: string) {
  return (await tx.mechanicStaff.findMany({ where: { partnerId, active: true }, select: { userId: true } })).map((s) => s.userId);
}

async function notify(tx: Tx, userIds: string[], type: string, title: string, body: string, link: string) {
  for (const userId of userIds) await enqueueOutbox(tx, { queue: "notifications", name: "send", payload: { userId, channel: "IN_APP", type, title, body, link } });
}

async function alertAdmins(tx: Tx, type: string, title: string, body: string, link: string) {
  const admins = await tx.user.findMany({ where: { roles: { has: "ADMIN" }, status: "ACTIVE" }, select: { id: true } });
  await notify(tx, admins.map((a) => a.id), type, title, body, link);
}

/**
 * O5 effect, inside the seller's confirmation transaction: book a garage for the chosen slot.
 * No garage serves the pincode → no inspection, the order waits in INSPECTION_SCHEDULED for an admin (never skipped).
 * The slot's day is full → FieldError, so the seller picks another slot.
 */
export async function scheduleInspection(tx: Tx, order: { id: string; listingId: string; sellerId: string; buyerId: string; inspectionReason: string | null; checkFeePaise: number; pickupAddress: Prisma.JsonValue }, pincode: string | null, slot: PickupSlot | null, actor: { type: "USER" | "ADMIN" | "SYSTEM"; id: string | null }, requestId?: string): Promise<string | null> {
  if (!slot || !pincode || !(await hasCoverage(tx, pincode))) {
    await recordAudit(tx, { actor, action: "inspection.unassigned", entity: { type: "Order", id: order.id }, after: { reason: "no garage serves the seller's pincode", pincode }, requestId });
    await alertAdmins(tx, "inspection.no_garage", "Partner Check needs a garage", "No partner garage serves this seller's area. Assign one so the order can continue.", "/admin/mechanics");
    return null;
  }
  const [best] = await rankGarages(tx, pincode, slot.start, { lock: true });
  if (!best) throw new FieldError({ inspectionSlot: "That day is fully booked. Choose another slot." });
  const inspection = await tx.inspection.create({
    data: {
      listingId: order.listingId,
      orderId: order.id,
      partnerId: best.id,
      reason: (order.inspectionReason ?? "TIER_C") as Prisma.InspectionCreateInput["reason"],
      status: "SCHEDULED",
      slotStart: slot.start,
      slotEnd: slot.end,
      locationAddress: order.pickupAddress ?? Prisma.JsonNull,
      buyerFeePaise: order.checkFeePaise,
    },
    select: { id: true },
  });
  await recordAudit(tx, { actor, action: "inspection.assigned", entity: { type: "Inspection", id: inspection.id }, after: { orderId: order.id, partnerId: best.id, slot: slot.id, load: best.load }, requestId });
  await notify(tx, await staffOf(tx, best.id), "inspection.job_assigned", "New Partner Check job", "A new Partner Check was booked with your garage.", `/mechanic/jobs/${inspection.id}`);
  await notify(tx, [order.sellerId], "inspection.scheduled", "Partner Check booked", `A partner garage, ${best.garageName}, will check the part in your chosen slot.`, `/seller/orders/${order.id}`);
  await notify(tx, [order.buyerId], "inspection.scheduled", "Partner Check booked", "A partner garage will check the part before it is sent.", `/orders/${order.id}`);
  return inspection.id;
}

// ── mechanic portal ──

async function mechanicPartner(db: Pick<Db, "mechanicStaff">, userId: string) {
  const staff = await db.mechanicStaff.findUnique({ where: { userId }, include: { partner: true, user: { select: { roles: true } } } });
  if (!staff || !staff.active || !staff.user.roles.includes("MECHANIC")) throw new ForbiddenError();
  return staff.partner;
}

async function assignedJob(db: Pick<Db, "mechanicStaff" | "inspection">, userId: string, inspectionId: string) {
  const partner = await mechanicPartner(db, userId);
  const job = await db.inspection.findUnique({ where: { id: inspectionId } });
  if (!job || job.partnerId !== partner.id) throw new NotFoundError("job");
  return { partner, job };
}

const jobSelect = { id: true, status: true, reason: true, slotStart: true, slotEnd: true, locationAddress: true, outcome: true, completedAt: true, listing: { select: { title: true, partName: true } } } as const;

export async function mechanicJobs(db: Db, userId: string, now = new Date()) {
  const partner = await mechanicPartner(db, userId);
  const jobs = await db.inspection.findMany({ where: { partnerId: partner.id, status: { in: [...OPEN] } }, select: jobSelect, orderBy: { slotStart: "asc" } });
  const [, todayEnd] = istDay(now);
  return { partner: { garageName: partner.garageName }, today: jobs.filter((j) => j.slotStart && j.slotStart < todayEnd), upcoming: jobs.filter((j) => !j.slotStart || j.slotStart >= todayEnd) };
}

export async function mechanicHistory(db: Db, userId: string) {
  const partner = await mechanicPartner(db, userId);
  const done = await db.inspection.findMany({ where: { partnerId: partner.id, status: "COMPLETED" }, select: jobSelect, orderBy: { completedAt: "desc" }, take: 200 });
  const count = await db.inspection.count({ where: { partnerId: partner.id, status: "COMPLETED" } });
  // Earnings are an accounting view: completed checks (any outcome, audits included) × the garage's fee. Paid off-platform [A-4].
  return { partner: { garageName: partner.garageName, feePerInspection: partner.feePerInspection }, done, completedCount: count, earningsPaise: count * partner.feePerInspection };
}

type ChecklistItem = { id: string; question: string };
type Shot = { shotType: string; label: string; instructions?: string; required?: boolean };

export async function mechanicJob(db: Db, deps: InspectionDeps, userId: string, inspectionId: string) {
  const { job } = await assignedJob(db, userId, inspectionId);
  const listing = await db.listing.findUniqueOrThrow({
    where: { id: job.listingId },
    select: { title: true, partName: true, partNumberEntered: true, conditionGrade: true, description: true, category: { select: { name: true, conditionChecklist: true, photoGuide: true } }, photos: { where: { storageKey: { not: null } }, orderBy: { sortOrder: "asc" }, select: { storageKey: true, shotType: true } } },
  });
  const photos = await db.inspectionPhoto.findMany({ where: { inspectionId }, orderBy: { createdAt: "asc" } });
  const sign = (bucket: string, key: string) => deps.storage.createSignedDownloadUrl(bucket, key, VIEW_TTL_SECONDS);
  return {
    job,
    listing: { title: listing.title ?? listing.partName ?? "Part", partNumber: listing.partNumberEntered, grade: listing.conditionGrade, description: listing.description, category: listing.category?.name ?? null },
    checklist: ((listing.category?.conditionChecklist ?? []) as ChecklistItem[]).map((c) => ({ id: c.id, question: c.question })),
    shots: ((listing.category?.photoGuide ?? []) as Shot[]).map((s) => ({ shotType: s.shotType, label: s.label, required: s.required !== false })),
    sellerPhotos: await Promise.all(listing.photos.map(async (p) => ({ shotType: p.shotType, url: await sign(deps.listingBucket, p.storageKey!) }))),
    photos: await Promise.all(photos.map(async (p) => ({ id: p.id, shotType: p.shotType, ready: !!p.storageKey, url: p.storageKey ? await sign(deps.bucket, p.storageKey) : null }))),
  };
}

export async function requestInspectionPhoto(db: Db, deps: InspectionDeps, actor: Actor, input: { inspectionId: string; shotType: string; size: number; type: string }) {
  const { job } = await assignedJob(db, actor.userId, input.inspectionId);
  if (job.status !== "SCHEDULED") throw new UserError("Photos can only be added before the inspection is submitted.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(input.type)) throw new FieldError({ file: "Use a JPEG, PNG or WebP photo." });
  if (input.size <= 0 || input.size > MAX_PHOTO_BYTES) throw new FieldError({ file: "Photos must be under 10 MB." });
  if (!/^[a-z0-9_-]{1,40}$/i.test(input.shotType)) throw new FieldError({ shotType: "Choose one of the photos in the list." });
  const incomingKey = `incoming/inspections/${job.id}/${randomUUID()}`;
  const photo = await db.inspectionPhoto.create({ data: { inspectionId: job.id, shotType: input.shotType, incomingKey } });
  const upload = await deps.storage.createSignedUploadUrl(deps.bucket, incomingKey, UPLOAD_TTL_SECONDS);
  return { photoId: photo.id, uploadUrl: upload.url };
}

/** The upload finished: check and re-encode it (EXIF/GPS removed) into the private inspection bucket. Idempotent. */
export async function confirmInspectionPhoto(db: Db, deps: InspectionDeps, actor: Actor, photoId: string): Promise<"ready" | "failed"> {
  const photo = await db.inspectionPhoto.findUnique({ where: { id: photoId } });
  if (!photo) throw new NotFoundError("photo");
  await assignedJob(db, actor.userId, photo.inspectionId);
  if (photo.storageKey) return "ready";
  if (!photo.incomingKey) return "failed";
  const cleaned = await cleanPhoto(await deps.storage.get(deps.bucket, photo.incomingKey));
  await deps.storage.delete(deps.bucket, photo.incomingKey).catch(() => {});
  if ("problem" in cleaned) {
    logger.warn({ photoId, reason: cleaned.problem }, "inspection photo rejected");
    await db.inspectionPhoto.delete({ where: { id: photoId } });
    return "failed";
  }
  const storageKey = `inspections/${photo.inspectionId}/${photo.id}.jpg`;
  await deps.storage.put(deps.bucket, storageKey, new Uint8Array(cleaned.clean), "image/jpeg");
  // Replacing a shot: keep only the newest photo for that shot type.
  const older = await db.inspectionPhoto.findMany({ where: { inspectionId: photo.inspectionId, shotType: photo.shotType, id: { not: photo.id } } });
  await db.$transaction([
    db.inspectionPhoto.update({ where: { id: photoId }, data: { storageKey, incomingKey: null, width: cleaned.info.width, height: cleaned.info.height } }),
    db.inspectionPhoto.deleteMany({ where: { id: { in: older.map((o) => o.id) } } }),
  ]);
  for (const o of older) if (o.storageKey) await deps.storage.delete(deps.bucket, o.storageKey).catch(() => {});
  return "ready";
}

// ── submitting the inspection ──

export const OUTCOMES = ["PASS", "PASS_WITH_NOTES", "FAIL"] as const;

/** Form fields: `outcome`, `notes`, `check_<itemId>` = yes|no, and up to 5 measured rows `m<i>_label|value|unit`. */
export function parseInspectionForm(raw: Record<string, unknown>, checklist: ChecklistItem[]) {
  const errors: Record<string, string> = {};
  const outcome = z.enum(OUTCOMES).safeParse(raw.outcome);
  if (!outcome.success) errors.outcome = "Choose the outcome.";
  const notes = typeof raw.notes === "string" ? raw.notes.trim().slice(0, 2000) : "";
  if (outcome.success && outcome.data !== "PASS" && notes.length < 10) errors.notes = "Explain what you found (at least 10 characters).";
  const checklistResults = checklist.map((c) => ({ id: c.id, question: c.question, answer: raw[`check_${c.id}`] }));
  for (const c of checklistResults) if (c.answer !== "yes" && c.answer !== "no") errors[`check_${c.id}`] = "Answer this question.";
  const measuredValues: Array<{ key: string; label: string; value: string; unit: string }> = [];
  for (let i = 0; i < 5; i++) {
    const label = String(raw[`m${i}_label`] ?? "").trim().slice(0, 60);
    const value = String(raw[`m${i}_value`] ?? "").trim().slice(0, 30);
    const unit = String(raw[`m${i}_unit`] ?? "").trim().slice(0, 15);
    if (!label && !value) continue;
    if (!label || !value) {
      errors[`m${i}_value`] = "Give both a name and a value, or leave the row empty.";
      continue;
    }
    measuredValues.push({ key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `m${i}`, label, value, unit });
  }
  if (Object.keys(errors).length) throw new FieldError(errors);
  return { outcome: outcome.data as InspectionOutcome, notes, checklistResults: checklistResults as Array<{ id: string; question: string; answer: "yes" | "no" }>, measuredValues };
}

/**
 * Submit inspection (O10 / O11). Required photos (the category photo guide) must be uploaded. PASS and
 * PASS_WITH_NOTES → INSPECTION_PASSED, Partner Check label, then the M9 hook books the pickup (or handover).
 * FAIL → order CANCELLED with a full refund including the check fee, listing CHANGES_REQUESTED with the notes.
 * A second submission does nothing.
 */
export async function submitInspection(db: Db, deps: InspectionDeps, actor: Actor, inspectionId: string, raw: Record<string, unknown>, now = new Date()) {
  const { partner, job } = await assignedJob(db, actor.userId, inspectionId);
  if (job.status === "COMPLETED") return { already: true, outcome: job.outcome };
  if (job.status !== "SCHEDULED") throw new UserError("This job isn't open any more.");
  if (!job.orderId) throw new UserError("This job isn't linked to an order.");
  const listing = await db.listing.findUniqueOrThrow({ where: { id: job.listingId }, select: { category: { select: { conditionChecklist: true, photoGuide: true } } } });
  const form = parseInspectionForm(raw, (listing.category?.conditionChecklist ?? []) as ChecklistItem[]);
  const required = ((listing.category?.photoGuide ?? []) as Shot[]).filter((s) => s.required !== false).map((s) => s.shotType);
  const have = new Set((await db.inspectionPhoto.findMany({ where: { inspectionId, storageKey: { not: null } }, select: { shotType: true } })).map((p) => p.shotType));
  const missing = required.filter((s) => !have.has(s));
  if (missing.length) throw new FieldError({ photos: `Add the required photos first (${missing.length} missing).` });

  const orderId = job.orderId;
  const mech = { type: "MECHANIC" as const, id: actor.userId };
  const passed = form.outcome !== "FAIL";
  const onTime = !!job.slotStart && istDay(job.slotStart)[0].getTime() === istDay(now)[0].getTime();
  await db.$transaction(async (tx) => {
    const { count } = await tx.inspection.updateMany({
      where: { id: inspectionId, status: "SCHEDULED" },
      data: { status: "COMPLETED", outcome: form.outcome, notes: form.notes || null, checklistResults: form.checklistResults, measuredValues: form.measuredValues, completedAt: now, mechanicUserId: actor.userId },
    });
    if (!count) throw new UserError("This inspection was already submitted.");
    // Garage quality stats. ponytail: "on time" = completed on the slot's IST day; a finer SLA can replace it later.
    const done = partner.inspectionsCompleted + 1;
    const fails = Math.round((partner.failRate ?? 0) * partner.inspectionsCompleted) + (passed ? 0 : 1);
    const onTimes = Math.round((partner.onTimeRate ?? 0) * partner.inspectionsCompleted) + (onTime ? 1 : 0);
    await tx.mechanicPartner.update({ where: { id: partner.id }, data: { inspectionsCompleted: done, failRate: fails / done, onTimeRate: onTimes / done } });
    await recordAudit(tx, { actor: mech, action: "inspection.submitted", entity: { type: "Inspection", id: inspectionId }, after: { outcome: form.outcome, orderId, measured: form.measuredValues.length }, requestId: actor.requestId });

    if (passed) {
      await transitionOrder(tx, { orderId, event: "inspectionPassed", actor: mech, requestId: actor.requestId, payload: { outcome: form.outcome, inspectionId } });
      await tx.listing.update({ where: { id: job.listingId }, data: { trustLabel: "PARTNER_CHECK" } });
      if (form.outcome === "PASS_WITH_NOTES") {
        const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { buyerId: true } });
        await notify(tx, [o.buyerId], "inspection.passed_with_notes", "Partner Check passed with notes", "The garage passed the part and left notes. Read them on the order page.", `/orders/${orderId}`);
      }
    } else {
      await tx.shipment.updateMany({ where: { orderId, direction: "FORWARD", status: "QUOTED" }, data: { status: "CANCELLED" } }); // release the unbooked pickup slot
      await transitionOrder(tx, { orderId, event: "inspectionFailed", actor: mech, requestId: actor.requestId, reason: `Partner Check failed: ${form.notes}` });
      await requestRefund(tx, { orderId, components: await refundableComponents(tx, orderId), reason: "Partner Check failed (full refund including the check fee).", actor: mech, idempotencyKey: `refund:${orderId}:inspection_failed`, requestId: actor.requestId });
      const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { buyerId: true, sellerId: true } });
      await notify(tx, [o.buyerId], "inspection.failed", "Partner Check failed", "The partner garage found a problem, so the order was cancelled. You get a full refund, including the check fee.", `/orders/${orderId}`);
      await notify(tx, [o.sellerId], "inspection.failed", "Partner Check failed", "The partner garage found a problem. Read the notes and update your listing.", `/sell/${job.listingId}/status`);
    }
  });
  if (passed) {
    // M9 hook, after the inspection is safely recorded. A courier problem here doesn't undo the check; the seller can book from their order page.
    await afterInspectionPassed(db, { shipping: deps.shipping }, orderId, now).catch((err) => logger.error({ orderId, err: (err as Error).message }, "post-inspection pickup booking failed"));
  }
  return { already: false, outcome: form.outcome };
}

// ── Partner Check label ──

/** "Inspected by [garage] on [date]. Visual and basic check." for the listing's latest passed check (PLAN.md §6.2). */
export async function partnerCheckFor(db: Pick<Db, "inspection">, listingId: string) {
  const i = await db.inspection.findFirst({ where: { listingId, status: "COMPLETED", outcome: { in: ["PASS", "PASS_WITH_NOTES"] } }, orderBy: { completedAt: "desc" }, select: { completedAt: true, partner: { select: { garageName: true } } } });
  return i?.completedAt ? { garageName: i.partner.garageName, date: i.completedAt } : null;
}

/** A-18: the label lasts `partnerCheckLabelDays` after the check; then the screening label is restored. */
export async function expirePartnerCheckLabels(db: Db, now = new Date()) {
  const { settings } = await getActiveSettings(db);
  const cutoff = new Date(now.getTime() - settings.inspections.partnerCheckLabelDays * DAY_MS);
  const listings = await db.listing.findMany({ where: { trustLabel: "PARTNER_CHECK" }, select: { id: true } });
  let expired = 0;
  for (const l of listings) {
    const last = await partnerCheckFor(db, l.id);
    if (last && last.date >= cutoff) continue;
    const ra = await db.riskAssessment.findFirst({ where: { listingId: l.id }, orderBy: { createdAt: "desc" }, select: { hadHardFailure: true, score: true } });
    const label: TrustLabel = ra ? trustLabel(ra.hadHardFailure, ra.score, settings) : "SELLER_DECLARED";
    await db.$transaction(async (tx) => {
      await tx.listing.update({ where: { id: l.id }, data: { trustLabel: label } });
      await recordAudit(tx, { actor: { type: "SYSTEM", id: null }, action: "listing.partner_check_expired", entity: { type: "Listing", id: l.id }, before: { trustLabel: "PARTNER_CHECK" }, after: { trustLabel: label } });
    });
    expired++;
  }
  return expired;
}

// ── admin: garages, staff, assignment ──

const pincodes = z
  .string()
  .transform((s) => [...new Set(s.split(/[\s,]+/).filter(Boolean))])
  .refine((a) => a.length > 0 && a.every((p) => /^[1-9]\d{5}$/.test(p)), "Enter 6-digit pincodes separated by commas.");
export const garageInput = z.object({
  id: z.string().max(64).optional().transform((v) => v || undefined),
  garageName: z.string().trim().min(2).max(80),
  addressLine: z.string().trim().min(3).max(120),
  city: z.string().trim().min(2).max(60),
  state: z.string().trim().min(2).max(60),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a 6-digit pincode."),
  servicePincodes: pincodes,
  capacityPerDay: z.coerce.number().int().min(0).max(50),
  feePerInspection: z.coerce.number().int().min(0).max(10_000_000),
  active: z.union([z.boolean(), z.enum(["on", "true", "false", ""])]).optional().transform((v) => v === true || v === "on" || v === "true"),
});

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new FieldError(Object.fromEntries(r.error.issues.map((i) => [String(i.path[0] ?? "form"), i.message])));
  return r.data;
}

export async function saveGarage(db: Db, admin: Actor, raw: unknown) {
  const { id, ...data } = parse(garageInput, raw);
  const actor = { type: "ADMIN" as const, id: admin.userId };
  return db.$transaction(async (tx) => {
    const before = id ? await tx.mechanicPartner.findUnique({ where: { id } }) : null;
    if (id && !before) throw new NotFoundError("garage");
    const g = id ? await tx.mechanicPartner.update({ where: { id }, data }) : await tx.mechanicPartner.create({ data });
    await recordAudit(tx, { actor, action: id ? "mechanic.garage_updated" : "mechanic.garage_created", entity: { type: "MechanicPartner", id: g.id }, before: before ? { active: before.active, capacityPerDay: before.capacityPerDay, servicePincodes: before.servicePincodes } : undefined, after: { active: g.active, capacityPerDay: g.capacityPerDay, servicePincodes: g.servicePincodes }, requestId: admin.requestId });
    return g.id;
  });
}

/** Links a user (by phone) to a garage as staff and grants the mechanic role. One garage per mechanic. */
export async function linkMechanic(db: Db, admin: Actor, raw: unknown) {
  const input = parse(z.object({ partnerId: z.string().min(1).max(64), phone: z.string().trim().regex(/^\+91\d{10}$/, "Enter the phone as +91 and 10 digits.") }), raw);
  const actor = { type: "ADMIN" as const, id: admin.userId };
  await db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { phone: input.phone }, select: { id: true, roles: true } });
    if (!user) throw new FieldError({ phone: "No RePart account uses this phone number." });
    await tx.mechanicPartner.findUniqueOrThrow({ where: { id: input.partnerId } });
    const staff = await tx.mechanicStaff.upsert({ where: { userId: user.id }, create: { userId: user.id, partnerId: input.partnerId, active: true }, update: { partnerId: input.partnerId, active: true } });
    if (!user.roles.includes("MECHANIC")) await tx.user.update({ where: { id: user.id }, data: { roles: { push: "MECHANIC" } } });
    await recordAudit(tx, { actor, action: "mechanic.staff_linked", entity: { type: "MechanicStaff", id: staff.id }, after: { userId: user.id, partnerId: input.partnerId }, requestId: admin.requestId });
  });
}

export async function setStaffActive(db: Db, admin: Actor, staffId: string, active: boolean) {
  await db.$transaction(async (tx) => {
    const s = await tx.mechanicStaff.update({ where: { id: staffId }, data: { active } });
    await recordAudit(tx, { actor: { type: "ADMIN", id: admin.userId }, action: active ? "mechanic.staff_activated" : "mechanic.staff_deactivated", entity: { type: "MechanicStaff", id: s.id }, after: { active, partnerId: s.partnerId }, requestId: admin.requestId });
  });
}

export const reassignInput = z.object({
  orderId: z.string().min(1).max(64),
  slot: z.string().max(40),
  partnerId: z.string().max(64).optional().transform((v) => v || undefined),
  noShow: z.union([z.boolean(), z.enum(["on", "true", "false", ""])]).optional().transform((v) => v === true || v === "on" || v === "true"),
  reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(300),
});

/**
 * Admin (re)assignment for an order waiting on its Partner Check: a no-garage order, a no-show, or a reschedule.
 * The previous open job is cancelled (or marked NO_SHOW). Never cancels or refunds the order (NO_SHOW has no automatic rules).
 */
export async function reassignInspection(db: Db, admin: Actor, raw: unknown, now = new Date()) {
  const input = parse(reassignInput, raw);
  const slot = resolveSlot(input.slot, now);
  const actor = { type: "ADMIN" as const, id: admin.userId };
  return db.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: input.orderId }, select: { id: true, state: true, listingId: true, sellerId: true, buyerId: true, inspectionReason: true, checkFeePaise: true, pickupAddress: true, listing: { select: { pickupPincode: true } } } });
    if (!order) throw new NotFoundError("order");
    if (order.state !== "INSPECTION_SCHEDULED") throw new UserError("Only orders waiting for their Partner Check can be (re)assigned.");
    const pincode = order.listing.pickupPincode;
    if (!pincode) throw new UserError("The listing has no pickup pincode.");
    const previous = await tx.inspection.findFirst({ where: { orderId: order.id, status: { in: [...OPEN] } } });
    if (previous) await tx.inspection.update({ where: { id: previous.id }, data: { status: input.noShow ? "NO_SHOW" : "CANCELLED" } });
    const ranked = await rankGarages(tx, pincode, slot.start, { lock: true });
    const chosen = input.partnerId ? ranked.find((g) => g.id === input.partnerId) : ranked[0];
    if (!chosen) throw new FieldError(input.partnerId ? { partnerId: "That garage doesn't serve this area or is full that day." } : { slot: "No garage has capacity that day. Choose another slot." });
    const inspection = await tx.inspection.create({
      data: { listingId: order.listingId, orderId: order.id, partnerId: chosen.id, reason: order.inspectionReason ?? "TIER_C", status: "SCHEDULED", slotStart: slot.start, slotEnd: slot.end, locationAddress: order.pickupAddress ?? Prisma.JsonNull, buyerFeePaise: order.checkFeePaise },
      select: { id: true },
    });
    await recordAudit(tx, { actor, action: previous ? "inspection.reassigned" : "inspection.assigned", entity: { type: "Inspection", id: inspection.id }, before: previous ? { inspectionId: previous.id, partnerId: previous.partnerId, slotStart: previous.slotStart?.toISOString() ?? null, markedNoShow: input.noShow } : undefined, after: { orderId: order.id, partnerId: chosen.id, slot: slot.id, reason: input.reason }, requestId: admin.requestId });
    await notify(tx, await staffOf(tx, chosen.id), "inspection.job_assigned", "New Partner Check job", "A Partner Check was booked with your garage.", `/mechanic/jobs/${inspection.id}`);
    if (previous && previous.partnerId !== chosen.id) await notify(tx, await staffOf(tx, previous.partnerId), "inspection.job_reassigned", "Partner Check moved", "A Partner Check job was moved to another garage.", "/mechanic");
    await notify(tx, [order.sellerId], "inspection.rescheduled", "Partner Check appointment changed", "RePart booked a new Partner Check appointment for your order.", `/seller/orders/${order.id}`);
    return inspection.id;
  });
}

export async function adminGarages(db: Db, now = new Date()) {
  const [from, to] = istDay(now);
  const garages = await db.mechanicPartner.findMany({ orderBy: { garageName: "asc" }, include: { _count: { select: { staff: true } } } });
  const loads = await db.inspection.groupBy({ by: ["partnerId"], where: { status: { in: [...COUNTED] }, slotStart: { gte: from, lt: to } }, _count: { _all: true } });
  const load = new Map(loads.map((l) => [l.partnerId, l._count._all]));
  const waiting = await db.order.findMany({ where: { state: "INSPECTION_SCHEDULED", inspections: { none: { status: { in: [...OPEN] } } } }, select: { id: true, createdAt: true, listing: { select: { title: true, partName: true, pickupPincode: true } } }, orderBy: { createdAt: "asc" } });
  return { garages: garages.map((g) => ({ ...g, todayLoad: load.get(g.id) ?? 0 })), waiting };
}

export async function adminGarage(db: Db, id: string, now = new Date()) {
  const g = await db.mechanicPartner.findUnique({
    where: { id },
    include: {
      staff: { include: { user: { select: { name: true, phone: true } } } },
      inspections: { orderBy: { createdAt: "desc" }, take: 50, select: { id: true, orderId: true, status: true, outcome: true, reason: true, slotStart: true, completedAt: true } },
    },
  });
  if (!g) throw new NotFoundError("garage");
  return { ...g, slots: pickupSlots(now) };
}
