import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { createMockPaymentProvider, signMockWebhook } from "../../src/server/adapters/payment/mock";
import type { PaymentProvider } from "../../src/server/adapters/payment/types";
import { createMockShippingProvider } from "../../src/server/adapters/shipping/mock";
import { createMemoryStorageProvider } from "../../src/server/adapters/storage/memory";
import { FieldError, ForbiddenError, NotFoundError, UserError } from "../../src/server/http/errors";
import {
  adminGarages,
  confirmInspectionPhoto,
  expirePartnerCheckLabels,
  inspectionSlots,
  linkMechanic,
  mechanicHistory,
  mechanicJob,
  mechanicJobs,
  partnerCheckFor,
  rankGarages,
  reassignInspection,
  requestInspectionPhoto,
  saveGarage,
  setStaffActive,
  submitInspection,
} from "../../src/server/services/inspection/inspection";
import { payOrder, placeOrder } from "../../src/server/services/order/checkout";
import { confirmOrder, pickupSlots } from "../../src/server/services/order/fulfilment";
import { orderForUser, sellerOrder } from "../../src/server/services/order/read";
import { receivePaymentWebhook } from "../../src/server/services/payment/payment-events";
import { alwaysAuditVersion, noAuditVersion, removeSettingsFixtures } from "../setup/settings-fixtures";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const PAY_SECRET = "test-webhook-secret-0123456789";
const BUYER = "sample-user-buyer";
const BUYER2 = "sample-user-buyer-2";
const SELLER = "sample-user-seller";
const ADMIN = { userId: "sample-user-admin" };
const shipping = createMockShippingProvider({ webhookSecret: "ship-secret-0123456789" });
const payment = { ...createMockPaymentProvider({ webhookSecret: PAY_SECRET, baseUrl: "http://x" }), name: "fake" } as PaymentProvider;
const storage = createMemoryStorageProvider();
const ideps = { storage, bucket: "inspection-photos", listingBucket: "listing-photos", shipping };
const seller = { userId: SELLER };
let pinSeq = 0;
const newPin = () => String(800_000 + ++pinSeq); // unique per test run (the test DB is reset before each run)
let jpeg: Buffer;

async function garage(pins: string[], over: Partial<Prisma.MechanicPartnerCreateInput> = {}) {
  const g = await db.mechanicPartner.create({ data: { garageName: `Test garage ${randomUUID().slice(0, 6)}`, addressLine: "Lane 1", city: "Test", state: "Test", pincode: pins[0]!, servicePincodes: pins, capacityPerDay: 4, feePerInspection: 20_000, ...over } });
  return g;
}

async function mechanicFor(partnerId: string) {
  const u = await db.user.create({ data: { phone: `+915${String(Date.now()).slice(-6)}${String(++pinSeq).padStart(3, "0")}`.slice(0, 13), name: "Test Mechanic", roles: ["MEMBER", "MECHANIC"] } });
  await db.mechanicStaff.create({ data: { userId: u.id, partnerId, active: true } });
  return { userId: u.id };
}

async function newListing(src: string, over: Record<string, unknown>) {
  const s = await db.listing.findUniqueOrThrow({ where: { id: src } });
  const { checklistAnswers, ...rest } = s;
  for (const k of ["id", "createdAt", "updatedAt"] as const) delete (rest as Partial<typeof s>)[k];
  const id = `test-in-${randomUUID()}`;
  await db.listing.create({ data: { ...rest, id, status: "LIVE", version: 0, trustLabel: "SCREENED", checklistAnswers: checklistAnswers ?? Prisma.JsonNull, ...over } as Prisma.ListingUncheckedCreateInput });
  return id;
}

/** A paid order waiting for the seller. Default: a Tier C (Partner Check required) part at `pincode`. */
async function paidOrder(pincode: string, opts: { src?: string; local?: boolean; version?: number; order?: Prisma.OrderUpdateInput } = {}) {
  const listingId = await newListing(opts.src ?? "sample-listing-live-tier-c", { pickupPincode: pincode, ...(opts.local ? { fulfilmentMode: "LOCAL_PICKUP" } : {}) });
  const { orderId } = await placeOrder(db, { shipping, payment }, { userId: BUYER }, { listingId, addressId: opts.local ? undefined : "sample-addr-buyer" });
  await db.order.update({ where: { id: orderId }, data: { settingsVersion: opts.version ?? (await noAuditVersion(db)), ...opts.order } });
  await payOrder(db, { shipping, payment }, { userId: BUYER }, orderId, "http://x");
  await pay(orderId);
  return { orderId, listingId };
}

async function pay(orderId: string, eventId = `evt_${randomUUID()}`, paymentId = `pay_${orderId}`) {
  const total = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalPaise;
  const rawBody = JSON.stringify({ providerEventId: eventId, type: "PAYMENT_SUCCESS", providerType: "TEST", orderId, providerPaymentId: paymentId, amount: total, currency: "INR" });
  expect((await receivePaymentWebhook(db, payment, rawBody, signMockWebhook(PAY_SECRET, rawBody, Date.now()))).status).toBe(200);
}

const slots = (now = new Date()) => pickupSlots(now);
const inspectionOf = (orderId: string) => db.inspection.findFirst({ where: { orderId }, orderBy: { createdAt: "desc" } });

async function uploadRequiredPhotos(mech: { userId: string }, inspectionId: string) {
  const job = await mechanicJob(db, ideps, mech.userId, inspectionId);
  for (const s of job.shots.filter((x) => x.required)) {
    const { photoId } = await requestInspectionPhoto(db, ideps, mech, { inspectionId, shotType: s.shotType, size: jpeg.length, type: "image/jpeg" });
    const row = await db.inspectionPhoto.findUniqueOrThrow({ where: { id: photoId } });
    await storage.put("inspection-photos", row.incomingKey!, new Uint8Array(jpeg), "image/jpeg");
    expect(await confirmInspectionPhoto(db, ideps, mech, photoId)).toBe("ready");
  }
  return job;
}

async function answers(mech: { userId: string }, inspectionId: string, outcome: string, notes = "") {
  const job = await mechanicJob(db, ideps, mech.userId, inspectionId);
  return { outcome, notes, ...Object.fromEntries(job.checklist.map((c) => [`check_${c.id}`, "yes"])), m0_label: "Pad thickness", m0_value: "4.1", m0_unit: "mm" };
}

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
  jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#777777" } }).jpeg().toBuffer();
});
afterAll(async () => {
  await removeSettingsFixtures(db);
  await db.$disconnect();
});

describe("garage assignment and capacity", () => {
  it("ranks only active garages serving the pincode with room: lowest load, then on-time, then fail rate, then id", async () => {
    const pin = newPin();
    const a = await garage([pin], { onTimeRate: 0.9, failRate: 0.1 });
    const b = await garage([pin], { onTimeRate: 0.9, failRate: 0.05 });
    const c = await garage([pin], { onTimeRate: 0.5 });
    await garage([pin], { active: false, onTimeRate: 1 });
    await garage([newPin()], { onTimeRate: 1 });
    const day = slots()[0]!.start;
    expect((await rankGarages(db, pin, day)).map((g) => g.id)).toEqual([b.id, a.id, c.id]);
    const busy = await paidOrder(pin);
    await confirmOrder(db, { shipping }, seller, busy.orderId, { inspectionSlot: slots()[0]!.id });
    expect((await inspectionOf(busy.orderId))!.partnerId).toBe(b.id); // the best garage got the job
    expect((await rankGarages(db, pin, day)).map((g) => g.id)).toEqual([a.id, c.id, b.id]); // b now has load 1
  });

  it("never books a garage beyond its daily capacity; a full day disappears from the seller's slots", async () => {
    const pin = newPin();
    await garage([pin], { capacityPerDay: 2 });
    const day1 = slots()[0]!;
    const day2 = slots()[4]!;
    for (let i = 0; i < 2; i++) {
      const o = await paidOrder(pin);
      await confirmOrder(db, { shipping }, seller, o.orderId, { inspectionSlot: slots()[i]!.id });
    }
    const third = await paidOrder(pin);
    await expect(confirmOrder(db, { shipping }, seller, third.orderId, { inspectionSlot: day1.id })).rejects.toBeInstanceOf(FieldError);
    expect((await db.order.findUniqueOrThrow({ where: { id: third.orderId } })).state).toBe("AWAITING_SELLER");
    const offered = (await inspectionSlots(db, pin)).map((s) => s.id);
    expect(offered).not.toContain(day1.id);
    expect(offered).toContain(day2.id);
    await confirmOrder(db, { shipping }, seller, third.orderId, { inspectionSlot: day2.id });
    expect((await inspectionOf(third.orderId))!.slotStart).toEqual(day2.start);
  });

  it("concurrent confirmations can't exceed capacity", async () => {
    const pin = newPin();
    await garage([pin], { capacityPerDay: 1 });
    const [x, y] = [await paidOrder(pin), await paidOrder(pin)];
    const slot = slots()[1]!.id;
    const results = await Promise.allSettled([confirmOrder(db, { shipping }, seller, x.orderId, { inspectionSlot: slot }), confirmOrder(db, { shipping }, seller, y.orderId, { inspectionSlot: slot })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.inspection.count({ where: { orderId: { in: [x.orderId, y.orderId] } } })).toBe(1);
  });

  it("a missing or made-up inspection slot is refused", async () => {
    const pin = newPin();
    await garage([pin]);
    const o = await paidOrder(pin);
    await expect(confirmOrder(db, { shipping }, seller, o.orderId, {})).rejects.toBeInstanceOf(FieldError);
    await expect(confirmOrder(db, { shipping }, seller, o.orderId, { inspectionSlot: "2030-01-01T04:30:00.000Z" })).rejects.toBeInstanceOf(FieldError);
    expect(await inspectionOf(o.orderId)).toBeNull();
  });
});

describe("audit selection at payment (O4)", () => {
  it("a selected order becomes a free AUDIT check, the buyer is told, and it's recorded once", async () => {
    const pin = newPin();
    await garage([pin]);
    const { orderId } = await paidOrder(pin, { src: "sample-listing-live-tier-a", version: await alwaysAuditVersion(db) });
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(o).toMatchObject({ inspectionReason: "AUDIT", checkFeePaise: 0, state: "AWAITING_SELLER" });
    const note = await db.outboxJob.findFirstOrThrow({ where: { payload: { path: ["type"], equals: "order.audit_selected" }, AND: { payload: { path: ["link"], equals: `/orders/${orderId}` } } } });
    expect((note.payload as { body: string }).body).toBe("This order was picked for a routine quality check");
    await pay(orderId); // another delivery of a success for the same payment
    expect(await db.auditLog.count({ where: { entityId: orderId, action: "order.audit_selected" } })).toBe(1);
    await confirmOrder(db, { shipping }, seller, orderId, { inspectionSlot: slots()[0]!.id, slot: slots()[0]!.id });
    expect(await inspectionOf(orderId)).toMatchObject({ reason: "AUDIT", buyerFeePaise: 0, status: "SCHEDULED" });
  });

  it("local pickup orders are audited too; paid Partner Checks and 0% settings are not", async () => {
    const pin = newPin();
    await garage([pin]);
    const always = await alwaysAuditVersion(db);
    const local = await paidOrder(pin, { src: "sample-listing-live-tier-a", local: true, version: always });
    expect((await db.order.findUniqueOrThrow({ where: { id: local.orderId } })).inspectionReason).toBe("AUDIT");
    const required = await paidOrder(pin, { version: always });
    expect((await db.order.findUniqueOrThrow({ where: { id: required.orderId } })).inspectionReason).toBe("TIER_C");
    const none = await paidOrder(pin, { src: "sample-listing-live-tier-a" });
    expect((await db.order.findUniqueOrThrow({ where: { id: none.orderId } })).inspectionReason).toBeNull();
  });
});

describe("no garage in the area", () => {
  it("a REQUIRED check can't be bought where no garage works; admins are alerted once a day", async () => {
    const pin = newPin();
    const listingId = await newListing("sample-listing-live-tier-c", { pickupPincode: pin });
    await expect(placeOrder(db, { shipping, payment }, { userId: BUYER }, { listingId, addressId: "sample-addr-buyer" })).rejects.toThrow("Partner Check not available in your area");
    await expect(placeOrder(db, { shipping, payment }, { userId: BUYER }, { listingId, addressId: "sample-addr-buyer" })).rejects.toThrow(UserError);
    expect(await db.auditLog.count({ where: { entityId: listingId, action: "listing.partner_check_unavailable" } })).toBe(1);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("LIVE");
  });

  it("an audit order waits for an admin instead of skipping the check; the admin assigns a garage later", async () => {
    const pin = newPin();
    const { orderId } = await paidOrder(pin, { src: "sample-listing-live-tier-a", version: await alwaysAuditVersion(db) });
    expect((await sellerOrder(db, SELLER, orderId)).inspectionCoverage).toBe(false);
    await confirmOrder(db, { shipping }, seller, orderId, { slot: slots()[0]!.id });
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).state).toBe("INSPECTION_SCHEDULED");
    expect(await inspectionOf(orderId)).toBeNull();
    expect(await db.auditLog.count({ where: { entityId: orderId, action: "inspection.unassigned" } })).toBe(1);
    expect((await adminGarages(db)).waiting.map((w) => w.id)).toContain(orderId);
    const g = await garage([pin]);
    await reassignInspection(db, ADMIN, { orderId, slot: slots()[2]!.id, reason: "Garage onboarded for this area" });
    expect(await inspectionOf(orderId)).toMatchObject({ partnerId: g.id, status: "SCHEDULED" });
    expect((await adminGarages(db)).waiting.map((w) => w.id)).not.toContain(orderId);
  });
});

describe("mechanic portal and inspection", () => {
  it("only staff of the assigned garage can see and submit a job", async () => {
    const pin = newPin();
    const g = await garage([pin]);
    const other = await garage([newPin()]);
    const mine = await mechanicFor(g.id);
    const stranger = await mechanicFor(other.id);
    const { orderId } = await paidOrder(pin);
    await confirmOrder(db, { shipping }, seller, orderId, { inspectionSlot: slots()[0]!.id, slot: slots()[0]!.id });
    const inspection = (await inspectionOf(orderId))!;
    expect((await mechanicJobs(db, mine.userId)).today.concat((await mechanicJobs(db, mine.userId)).upcoming).map((j) => j.id)).toContain(inspection.id);
    await expect(mechanicJob(db, ideps, stranger.userId, inspection.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(submitInspection(db, ideps, stranger, inspection.id, {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(mechanicJobs(db, BUYER)).rejects.toBeInstanceOf(ForbiddenError); // not garage staff
    await expect(orderForUser(db, BUYER2, orderId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(sellerOrder(db, "sample-user-seller-nopayout", orderId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("required photos (category photo guide) are enforced; photos are private and served by short-lived signed URLs", async () => {
    const pin = newPin();
    const g = await garage([pin]);
    const mech = await mechanicFor(g.id);
    const { orderId } = await paidOrder(pin);
    await confirmOrder(db, { shipping }, seller, orderId, { inspectionSlot: slots()[0]!.id, slot: slots()[0]!.id });
    const id = (await inspectionOf(orderId))!.id;
    await expect(submitInspection(db, ideps, mech, id, await answers(mech, id, "PASS"))).rejects.toThrow(/required photos/);
    await uploadRequiredPhotos(mech, id);
    const job = await mechanicJob(db, ideps, mech.userId, id);
    expect(job.photos.length).toBeGreaterThan(0);
    for (const p of job.photos) expect(p.url).toMatch(/^memory:\/\/download\/inspection-photos\/inspections\/.+\?ttl=600$/);
    // A non-image upload is rejected and removed.
    const { photoId } = await requestInspectionPhoto(db, ideps, mech, { inspectionId: id, shotType: "extra", size: 10, type: "image/jpeg" });
    const row = await db.inspectionPhoto.findUniqueOrThrow({ where: { id: photoId } });
    await storage.put("inspection-photos", row.incomingKey!, new Uint8Array([1, 2, 3]), "image/jpeg");
    expect(await confirmInspectionPhoto(db, ideps, mech, photoId)).toBe("failed");
  });

  it("E2E pass: confirm → slot → garage → mechanic PASS → INSPECTION_PASSED → M9 hook books the pickup", async () => {
    const pin = newPin();
    const g = await garage([pin]);
    const mech = await mechanicFor(g.id);
    const { orderId, listingId } = await paidOrder(pin);
    const pickupSlot = slots()[3]!;
    await confirmOrder(db, { shipping }, seller, orderId, { inspectionSlot: slots()[0]!.id, slot: pickupSlot.id });
    const id = (await inspectionOf(orderId))!.id;
    await uploadRequiredPhotos(mech, id);
    expect(await submitInspection(db, ideps, mech, id, await answers(mech, id, "PASS"))).toEqual({ already: false, outcome: "PASS" });
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { events: { orderBy: { createdAt: "asc" } } } });
    expect(o.events.map((e) => e.toState)).toContain("INSPECTION_PASSED");
    expect(o.state).toBe("PICKUP_SCHEDULED"); // the stored pickup slot was still valid
    expect(await db.shipment.findFirstOrThrow({ where: { orderId, direction: "FORWARD" } })).toMatchObject({ status: "PICKUP_SCHEDULED", pickupSlotStart: pickupSlot.start });
    const inspection = await db.inspection.findUniqueOrThrow({ where: { id } });
    expect(inspection).toMatchObject({ status: "COMPLETED", outcome: "PASS", mechanicUserId: mech.userId });
    expect(inspection.measuredValues).toEqual([{ key: "pad_thickness", label: "Pad thickness", value: "4.1", unit: "mm" }]);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).trustLabel).toBe("PARTNER_CHECK");
    expect((await partnerCheckFor(db, listingId))!.garageName).toBe(g.garageName);
    expect(await db.outboxJob.count({ where: { payload: { path: ["type"], equals: "order.inspection_passed" }, AND: { payload: { path: ["link"], equals: `/orders/${orderId}` } } } })).toBe(2);
    expect((await submitInspection(db, ideps, mech, id, await answers(mech, id, "FAIL", "changed my mind about it"))).already).toBe(true);
    const h = await mechanicHistory(db, mech.userId);
    expect(h).toMatchObject({ completedCount: 1, earningsPaise: 20_000 });
  });

  it("pass with notes: same transition, notes visible to the buyer; stale pickup slot asks for a new one; local pickup → handover", async () => {
    const pin = newPin();
    const g = await garage([pin]);
    const mech = await mechanicFor(g.id);
    const d = await paidOrder(pin);
    await confirmOrder(db, { shipping }, seller, d.orderId, { inspectionSlot: slots()[0]!.id, slot: slots()[0]!.id });
    const id = (await inspectionOf(d.orderId))!.id;
    await uploadRequiredPhotos(mech, id);
    const later = new Date(Date.now() + 10 * 86_400_000);
    await submitInspection(db, ideps, mech, id, await answers(mech, id, "PASS_WITH_NOTES", "Light scratches on the backing plate"), later);
    expect((await db.order.findUniqueOrThrow({ where: { id: d.orderId } })).state).toBe("INSPECTION_PASSED"); // stored slot is stale: seller must pick again
    const view = await orderForUser(db, BUYER, d.orderId);
    expect(view.inspection).toMatchObject({ outcome: "PASS_WITH_NOTES", notes: "Light scratches on the backing plate" });
    expect(await db.outboxJob.count({ where: { payload: { path: ["type"], equals: "order.pickup_slot_needed" }, AND: { payload: { path: ["link"], equals: `/seller/orders/${d.orderId}` } } } })).toBe(1);

    const local = await paidOrder(pin, { local: true });
    await confirmOrder(db, { shipping }, seller, local.orderId, { inspectionSlot: slots()[1]!.id });
    const lid = (await inspectionOf(local.orderId))!.id;
    await uploadRequiredPhotos(mech, lid);
    await submitInspection(db, ideps, mech, lid, await answers(mech, lid, "PASS"));
    expect((await db.order.findUniqueOrThrow({ where: { id: local.orderId } })).state).toBe("AWAITING_HANDOVER");
  });

  it("E2E fail: CANCELLED, full refund incl. the check fee, listing CHANGES_REQUESTED with notes, no shipment, slots released", async () => {
    const pin = newPin();
    const g = await garage([pin]);
    const mech = await mechanicFor(g.id);
    const { orderId, listingId } = await paidOrder(pin);
    await confirmOrder(db, { shipping }, seller, orderId, { inspectionSlot: slots()[0]!.id, slot: slots()[2]!.id });
    const id = (await inspectionOf(orderId))!.id;
    await uploadRequiredPhotos(mech, id);
    const notes = "Pads worn below the minimum thickness";
    await submitInspection(db, ideps, mech, id, await answers(mech, id, "FAIL", notes));
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(o.state).toBe("CANCELLED");
    expect(o.checkFeePaise).toBeGreaterThan(0);
    const refund = await db.refund.findFirstOrThrow({ where: { payment: { orderId } } });
    expect(refund).toMatchObject({ amountPaise: o.totalPaise, idempotencyKey: `refund:${orderId}:inspection_failed` });
    expect((refund.components as { check: number }).check).toBe(o.checkFeePaise);
    const listing = await db.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe("CHANGES_REQUESTED");
    expect(listing.sellerMessage).toContain(notes);
    expect(await db.shipment.count({ where: { orderId, providerRef: { not: null } } })).toBe(0);
    expect(await db.shipment.count({ where: { orderId, status: { not: "CANCELLED" } } })).toBe(0); // the stored pickup slot is released
    const failNotices = await db.outboxJob.findMany({ where: { payload: { path: ["type"], equals: "inspection.failed" } } });
    expect(failNotices.map((n) => (n.payload as { link: string }).link)).toEqual(expect.arrayContaining([`/orders/${orderId}`, `/sell/${listingId}/status`]));
    expect((await submitInspection(db, ideps, mech, id, await answers(mech, id, "FAIL", notes))).already).toBe(true);
    expect(await db.refund.count({ where: { payment: { orderId } } })).toBe(1);
  });

  it("the Partner Check label expires after partnerCheckLabelDays", async () => {
    const pin = newPin();
    const g = await garage([pin]);
    const mech = await mechanicFor(g.id);
    const { orderId, listingId } = await paidOrder(pin, { local: true });
    await confirmOrder(db, { shipping }, seller, orderId, { inspectionSlot: slots()[0]!.id });
    const id = (await inspectionOf(orderId))!.id;
    await uploadRequiredPhotos(mech, id);
    await submitInspection(db, ideps, mech, id, await answers(mech, id, "PASS"));
    await expirePartnerCheckLabels(db);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).trustLabel).toBe("PARTNER_CHECK"); // still within 30 days
    await db.inspection.update({ where: { id }, data: { completedAt: new Date(Date.now() - 31 * 86_400_000) } });
    await expirePartnerCheckLabels(db);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).trustLabel).not.toBe("PARTNER_CHECK");
  });
});

describe("admin garage management", () => {
  it("onboards and edits garages with validated service areas and capacity, audited", async () => {
    await expect(saveGarage(db, ADMIN, { garageName: "X", addressLine: "Road", city: "C", state: "S", pincode: "560001", servicePincodes: "12, abc", capacityPerDay: "4", feePerInspection: "0" })).rejects.toBeInstanceOf(FieldError);
    const id = await saveGarage(db, ADMIN, { garageName: "New Garage", addressLine: "Road 2", city: "Pune", state: "MH", pincode: "411001", servicePincodes: "411001, 411002", capacityPerDay: "6", feePerInspection: "25000", active: "on" });
    await saveGarage(db, ADMIN, { id, garageName: "New Garage", addressLine: "Road 2", city: "Pune", state: "MH", pincode: "411001", servicePincodes: "411001,411003", capacityPerDay: "2", feePerInspection: "25000", active: "" });
    expect(await db.mechanicPartner.findUniqueOrThrow({ where: { id } })).toMatchObject({ servicePincodes: ["411001", "411003"], capacityPerDay: 2, active: false });
    expect(await db.auditLog.count({ where: { entityId: id, action: { in: ["mechanic.garage_created", "mechanic.garage_updated"] } } })).toBe(2);
  });

  it("links a mechanic by phone (granting the role) and can deactivate them", async () => {
    const g = await garage([newPin()]);
    const u = await db.user.create({ data: { phone: `+914${String(Date.now()).slice(-9)}`, name: "New Mechanic" } });
    await linkMechanic(db, ADMIN, { partnerId: g.id, phone: u.phone });
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).roles).toContain("MECHANIC");
    expect((await mechanicJobs(db, u.id)).partner.garageName).toBe(g.garageName);
    const staff = await db.mechanicStaff.findUniqueOrThrow({ where: { userId: u.id } });
    await setStaffActive(db, ADMIN, staff.id, false);
    await expect(mechanicJobs(db, u.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.auditLog.count({ where: { entityId: staff.id, action: { in: ["mechanic.staff_linked", "mechanic.staff_deactivated"] } } })).toBe(2);
  });

  it("no-show: the admin reschedules/reassigns; the order is never cancelled or refunded automatically", async () => {
    const pin = newPin();
    const first = await garage([pin], { onTimeRate: 1 });
    const second = await garage([pin]);
    const { orderId } = await paidOrder(pin);
    await confirmOrder(db, { shipping }, seller, orderId, { inspectionSlot: slots()[0]!.id, slot: slots()[0]!.id });
    const old = (await inspectionOf(orderId))!;
    expect(old.partnerId).toBe(first.id);
    await expect(reassignInspection(db, ADMIN, { orderId, slot: slots()[5]!.id, partnerId: second.id, noShow: "on", reason: "" })).rejects.toBeInstanceOf(FieldError);
    await reassignInspection(db, ADMIN, { orderId, slot: slots()[5]!.id, partnerId: second.id, noShow: "on", reason: "Mechanic couldn't reach the seller" });
    expect((await db.inspection.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("NO_SHOW");
    const now = (await inspectionOf(orderId))!;
    expect(now).toMatchObject({ partnerId: second.id, status: "SCHEDULED", slotStart: slots()[5]!.start });
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).state).toBe("INSPECTION_SCHEDULED");
    expect(await db.refund.count({ where: { payment: { orderId } } })).toBe(0);
    expect(await db.auditLog.count({ where: { entityId: now.id, action: "inspection.reassigned" } })).toBe(1);
  });
});
