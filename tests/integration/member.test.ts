import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { FieldError, NotFoundError, UserError } from "../../src/server/http/errors";
import {
  createAddress,
  deleteAddress,
  listAddresses,
  setDefaultAddress,
  updateAddress,
  type AddressInput,
} from "../../src/server/services/address/address";
import {
  CONSENT_POLICY_VERSION,
  grantConsents,
  hasRequiredConsent,
  listConsentStatus,
  withdrawConsent,
} from "../../src/server/services/consent/consent";
import {
  addGarageVehicle,
  listGarage,
  removeGarageVehicle,
  setPrimaryVehicle,
  updateGarageVehicle,
} from "../../src/server/services/garage/garage";
import { completeAboutYou } from "../../src/server/services/profile/profile";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
let variant: { id: string; yearFrom: number; yearTo: number | null };
let seq = 0;

async function newUser() {
  seq++;
  return db.user.create({ data: { phone: `+917${String(Date.now() % 1e5).padStart(5, "0")}${String(seq).padStart(4, "0")}` } });
}

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
  variant = await db.vehicleVariant.findFirstOrThrow({ where: { yearTo: { not: null } } });
});
afterAll(async () => {
  await db.$disconnect();
});

describe("consent (versioned)", () => {
  it("seeded SAMPLE users already consent at the current version", async () => {
    expect(await hasRequiredConsent(db, "sample-user-buyer")).toBe(true);
  });

  it("about-you saves the profile and records required + chosen optional consents", async () => {
    const user = await newUser();
    expect(await hasRequiredConsent(db, user.id)).toBe(false);
    await completeAboutYou(db, { userId: user.id }, { name: "  Asha Rao ", email: "ASHA@example.com", optionalConsents: ["MARKETING_SMS"] });

    const saved = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(saved).toMatchObject({ name: "Asha Rao", email: "asha@example.com" });
    expect(await hasRequiredConsent(db, user.id)).toBe(true);
    const status = Object.fromEntries((await listConsentStatus(db, user.id)).map((s) => [s.purpose, s.granted]));
    expect(status).toEqual({ ACCOUNT_AND_ORDERS: true, PHOTO_TRAINING_DATA: false, MARKETING_SMS: true });
    expect(await db.auditLog.count({ where: { entityId: user.id, action: "consent.granted" } })).toBe(2);
  });

  it("about-you rejects a missing name or invalid email", async () => {
    const user = await newUser();
    await expect(completeAboutYou(db, { userId: user.id }, { name: "A", email: "", optionalConsents: [] })).rejects.toThrow();
    await expect(completeAboutYou(db, { userId: user.id }, { name: "Asha", email: "nope", optionalConsents: [] })).rejects.toThrow();
    expect(await hasRequiredConsent(db, user.id)).toBe(false);
  });

  it("an older policy version does not count, and re-consenting closes the old record", async () => {
    const user = await newUser();
    await db.consentRecord.create({ data: { userId: user.id, purpose: "ACCOUNT_AND_ORDERS", version: "2025-01-01" } });
    expect(await hasRequiredConsent(db, user.id)).toBe(false);
    await grantConsents(db, { userId: user.id }, ["ACCOUNT_AND_ORDERS"]);
    const rows = await db.consentRecord.findMany({ where: { userId: user.id }, orderBy: { grantedAt: "asc" } });
    expect(rows.map((r) => [r.version, r.withdrawnAt === null])).toEqual([
      ["2025-01-01", false],
      [CONSENT_POLICY_VERSION, true],
    ]);
    await grantConsents(db, { userId: user.id }, ["ACCOUNT_AND_ORDERS"]); // idempotent
    expect(await db.consentRecord.count({ where: { userId: user.id } })).toBe(2);
  });

  it("optional consents can be withdrawn; the required one cannot", async () => {
    const user = await newUser();
    await grantConsents(db, { userId: user.id }, ["ACCOUNT_AND_ORDERS", "PHOTO_TRAINING_DATA"]);
    await withdrawConsent(db, { userId: user.id }, "PHOTO_TRAINING_DATA");
    expect((await listConsentStatus(db, user.id)).find((s) => s.purpose === "PHOTO_TRAINING_DATA")?.granted).toBe(false);
    await expect(withdrawConsent(db, { userId: user.id }, "ACCOUNT_AND_ORDERS")).rejects.toBeInstanceOf(UserError);
    expect(await hasRequiredConsent(db, user.id)).toBe(true);
  });
});

describe("addresses", () => {
  const input = (over: Partial<AddressInput> & { makeDefault?: boolean } = {}) => ({
    contactName: "Asha Rao",
    contactPhone: "98765 43210",
    line1: "12 MG Road",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560001",
    ...over,
  });

  it("first address is default; makeDefault moves the default", async () => {
    const user = await newUser();
    const a = await createAddress(db, user.id, input());
    const b = await createAddress(db, user.id, input({ label: "Work" }));
    expect(a.isDefault).toBe(true);
    expect(b.isDefault).toBe(false);
    expect(a.contactPhone).toBe("+919876543210");
    await createAddress(db, user.id, input({ makeDefault: true, label: "New" }));
    expect((await listAddresses(db, user.id)).filter((x) => x.isDefault).map((x) => x.label)).toEqual(["New"]);
    await setDefaultAddress(db, user.id, b.id);
    expect((await listAddresses(db, user.id))[0]?.id).toBe(b.id);
  });

  it("deleting the default promotes the oldest remaining address", async () => {
    const user = await newUser();
    const a = await createAddress(db, user.id, input());
    const b = await createAddress(db, user.id, input({ label: "Second" }));
    await deleteAddress(db, user.id, a.id);
    expect((await listAddresses(db, user.id)).map((x) => [x.id, x.isDefault])).toEqual([[b.id, true]]);
  });

  it("validates pincode and phone", async () => {
    const user = await newUser();
    await expect(createAddress(db, user.id, input({ pincode: "012345" }))).rejects.toThrow();
    await expect(createAddress(db, user.id, input({ contactPhone: "12345" }))).rejects.toThrow();
  });

  it("users cannot read, edit or delete someone else's address", async () => {
    const owner = await newUser();
    const other = await newUser();
    const a = await createAddress(db, owner.id, input());
    await expect(updateAddress(db, other.id, a.id, input({ city: "Mysuru" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteAddress(db, other.id, a.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(setDefaultAddress(db, other.id, a.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await db.address.findUniqueOrThrow({ where: { id: a.id } })).city).toBe("Bengaluru");
  });
});

describe("garage", () => {
  const bike = (over: Record<string, unknown> = {}) => ({ variantId: variant.id, year: String(variant.yearFrom), ...over });

  it("first bike becomes primary; set primary switches it", async () => {
    const user = await newUser();
    const a = await addGarageVehicle(db, user.id, bike({ nickname: "Daily" }));
    const b = await addGarageVehicle(db, user.id, bike());
    expect([a.isPrimary, b.isPrimary]).toEqual([true, false]);
    await setPrimaryVehicle(db, user.id, b.id);
    expect((await listGarage(db, user.id)).map((v) => [v.id, v.isPrimary])).toEqual([
      [b.id, true],
      [a.id, false],
    ]);
  });

  it("removing the primary bike promotes the oldest remaining", async () => {
    const user = await newUser();
    const a = await addGarageVehicle(db, user.id, bike());
    const b = await addGarageVehicle(db, user.id, bike());
    await removeGarageVehicle(db, user.id, a.id);
    expect((await listGarage(db, user.id)).map((v) => [v.id, v.isPrimary])).toEqual([[b.id, true]]);
  });

  it("rejects a year outside the variant's production range and unknown variants", async () => {
    const user = await newUser();
    await expect(addGarageVehicle(db, user.id, bike({ year: String(variant.yearFrom - 1) }))).rejects.toBeInstanceOf(FieldError);
    await expect(addGarageVehicle(db, user.id, bike({ variantId: "nope" }))).rejects.toBeInstanceOf(FieldError);
  });

  it("edits are limited to the owner", async () => {
    const owner = await newUser();
    const other = await newUser();
    const v = await addGarageVehicle(db, owner.id, bike());
    await expect(updateGarageVehicle(db, other.id, v.id, bike({ nickname: "Mine now" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(setPrimaryVehicle(db, other.id, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeGarageVehicle(db, other.id, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await updateGarageVehicle(db, owner.id, v.id, bike({ nickname: "Weekend" }));
    expect((await db.garageVehicle.findUniqueOrThrow({ where: { id: v.id } })).nickname).toBe("Weekend");
  });

  it("the database rejects a second primary bike", async () => {
    const user = await newUser();
    await addGarageVehicle(db, user.id, bike());
    await expect(db.garageVehicle.create({ data: { userId: user.id, variantId: variant.id, year: variant.yearFrom, isPrimary: true } })).rejects.toThrow();
  });
});
