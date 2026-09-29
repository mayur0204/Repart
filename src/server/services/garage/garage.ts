import "server-only";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { FieldError, NotFoundError, UserError } from "../../http/errors";

/**
 * Garage (REPART_BRIEF.md §9): a user's bikes, one of which is primary. The first bike added
 * becomes primary; removing the primary promotes the oldest remaining bike. The partial unique
 * index GarageVehicle_one_primary_per_user backs the one-primary rule in the database.
 */
type Db = Pick<PrismaClient, "$transaction" | "garageVehicle" | "vehicleVariant">;

export const MAX_GARAGE_VEHICLES = 10;

export const garageVehicleInput = z.object({
  variantId: z.string().min(1, "Choose your bike's variant."),
  year: z.coerce.number({ message: "Choose the year." }).int("Choose the year."),
  nickname: z
    .string()
    .trim()
    .max(40, "Keep the nickname under 40 characters.")
    .optional()
    .transform((v) => (v ? v : null)),
});
export type GarageVehicleInput = z.input<typeof garageVehicleInput>;

const vehicleInclude = { variant: { include: { model: { include: { make: true } } } } } as const;

export function listGarage(db: Pick<PrismaClient, "garageVehicle">, userId: string) {
  return db.garageVehicle.findMany({
    where: { userId },
    include: vehicleInclude,
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
}

export function countGarage(db: Pick<PrismaClient, "garageVehicle">, userId: string) {
  return db.garageVehicle.count({ where: { userId } });
}

export async function getGarageVehicle(db: Pick<PrismaClient, "garageVehicle">, userId: string, id: string) {
  const vehicle = await db.garageVehicle.findFirst({ where: { id, userId }, include: vehicleInclude });
  if (!vehicle) throw new NotFoundError("bike");
  return vehicle;
}

async function validated(db: Pick<PrismaClient, "vehicleVariant">, input: GarageVehicleInput) {
  const data = garageVehicleInput.parse(input);
  const variant = await db.vehicleVariant.findUnique({ where: { id: data.variantId } });
  if (!variant) throw new FieldError({ variantId: "Choose your bike's variant from the list." });
  const lastYear = variant.yearTo ?? new Date().getFullYear();
  if (data.year < variant.yearFrom || data.year > lastYear) {
    throw new FieldError({ year: `This variant was made from ${variant.yearFrom} to ${variant.yearTo ?? "now"}. Choose a year in that range.` });
  }
  return data;
}

export async function addGarageVehicle(db: Db, userId: string, input: GarageVehicleInput) {
  const data = await validated(db, input);
  return db.$transaction(async (tx) => {
    const count = await tx.garageVehicle.count({ where: { userId } });
    if (count >= MAX_GARAGE_VEHICLES) throw new UserError(`You can keep up to ${MAX_GARAGE_VEHICLES} bikes. Remove one first.`);
    return tx.garageVehicle.create({ data: { ...data, userId, isPrimary: count === 0 } });
  });
}

export async function updateGarageVehicle(db: Db, userId: string, id: string, input: GarageVehicleInput) {
  const data = await validated(db, input);
  const { count } = await db.garageVehicle.updateMany({ where: { id, userId }, data });
  if (count === 0) throw new NotFoundError("bike");
}

export async function setPrimaryVehicle(db: Db, userId: string, id: string) {
  await db.$transaction(async (tx) => {
    await getGarageVehicle(tx, userId, id);
    await tx.garageVehicle.updateMany({ where: { userId, isPrimary: true }, data: { isPrimary: false } });
    await tx.garageVehicle.update({ where: { id }, data: { isPrimary: true } });
  });
}

export async function removeGarageVehicle(db: Db, userId: string, id: string) {
  await db.$transaction(async (tx) => {
    const vehicle = await getGarageVehicle(tx, userId, id);
    await tx.garageVehicle.delete({ where: { id } });
    if (vehicle.isPrimary) {
      const next = await tx.garageVehicle.findFirst({ where: { userId }, orderBy: { createdAt: "asc" } });
      if (next) await tx.garageVehicle.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
  });
}

/** Display name, e.g. "Sample Motors Roadster 150 (2019)". */
export function vehicleLabel(v: { year: number; variant: { name: string; model: { name: string; make: { name: string } } } }) {
  return `${v.variant.model.make.name} ${v.variant.model.name} ${v.variant.name} (${v.year})`;
}
