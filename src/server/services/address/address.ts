import "server-only";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { normalizeIndianPhone } from "@/lib/phone";
import { NotFoundError, UserError } from "../../http/errors";

/**
 * Saved addresses (PLAN.md §4.3). Orders copy the address as a snapshot, so editing or
 * deleting one here never changes past orders. Each user has at most one default.
 */
type Db = Pick<PrismaClient, "$transaction" | "address">;

export const MAX_ADDRESSES = 10;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .optional()
    .transform((v) => (v ? v : null));

export const addressInput = z.object({
  label: optionalText(40),
  contactName: z.string().trim().min(2, "Enter the name of the person at this address.").max(80),
  contactPhone: z
    .string()
    .transform((v, ctx) => {
      const phone = normalizeIndianPhone(v, { allowSample: process.env.NODE_ENV !== "production" });
      if (!phone) ctx.addIssue({ code: "custom", message: "Enter a 10-digit Indian mobile number." });
      return phone ?? "";
    }),
  line1: z.string().trim().min(3, "Enter the house number and street.").max(120),
  line2: optionalText(120),
  landmark: optionalText(80),
  city: z.string().trim().min(2, "Enter the town or city.").max(60),
  state: z.string().trim().min(2, "Enter the state.").max(60),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a 6-digit pincode, for example 560001."),
});
export type AddressInput = z.input<typeof addressInput>;

export function listAddresses(db: Pick<PrismaClient, "address">, userId: string) {
  return db.address.findMany({ where: { userId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
}

export async function getAddress(db: Pick<PrismaClient, "address">, userId: string, id: string) {
  const address = await db.address.findFirst({ where: { id, userId } });
  if (!address) throw new NotFoundError("address");
  return address;
}

export async function createAddress(db: Db, userId: string, input: AddressInput & { makeDefault?: boolean }) {
  const data = addressInput.parse(input);
  return db.$transaction(async (tx) => {
    const count = await tx.address.count({ where: { userId } });
    if (count >= MAX_ADDRESSES) throw new UserError(`You can save up to ${MAX_ADDRESSES} addresses. Delete one you no longer use first.`);
    const isDefault = count === 0 || !!input.makeDefault;
    if (isDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
    return tx.address.create({ data: { ...data, userId, isDefault } });
  });
}

export async function updateAddress(db: Db, userId: string, id: string, input: AddressInput) {
  const data = addressInput.parse(input);
  const { count } = await db.address.updateMany({ where: { id, userId }, data });
  if (count === 0) throw new NotFoundError("address");
}

export async function setDefaultAddress(db: Db, userId: string, id: string) {
  await db.$transaction(async (tx) => {
    await getAddress(tx, userId, id);
    await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
    await tx.address.update({ where: { id }, data: { isDefault: true } });
  });
}

/** Deleting the default makes the oldest remaining address the default. */
export async function deleteAddress(db: Db, userId: string, id: string) {
  await db.$transaction(async (tx) => {
    const address = await getAddress(tx, userId, id);
    await tx.address.delete({ where: { id } });
    if (address.isDefault) {
      const next = await tx.address.findFirst({ where: { userId }, orderBy: { createdAt: "asc" } });
      if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });
}
