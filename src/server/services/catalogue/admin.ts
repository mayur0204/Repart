import "server-only";
import { z } from "zod";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { normalizePartNumber } from "@/lib/part-number";
import { SLUG_PATTERN, slugify } from "@/lib/slug";
import { FieldError, NotFoundError, UserError } from "../../http/errors";
import { recordAudit } from "../audit/audit";

/**
 * Admin CRUD for the vehicle catalogue and part numbers (PLAN.md §4.8, M3).
 * Every change is audited with before/after. Deletes are refused while anything references the row.
 */
type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Actor = { userId: string; requestId?: string };
/** Raw form or test input; every save validates it with the matching Zod schema. */
type RawInput = Record<string, unknown> & { id?: string };

const text = (label: string, max = 80) => z.string().trim().min(1, `Enter the ${label}.`).max(max, `Keep the ${label} under ${max} characters.`);
const optionalSlug = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || SLUG_PATTERN.test(v), "Use lowercase letters, digits and single dashes, for example sample-motors.");
const year = (label: string) => z.coerce.number({ message: `Enter the ${label}.` }).int().min(1950, `Enter a ${label} from 1950.`).max(new Date().getFullYear() + 1);
const optionalInt = z
  .union([z.literal(""), z.coerce.number().int().positive()])
  .optional()
  .transform((v) => (v === "" || v === undefined ? null : v));

export const makeInput = z.object({ name: text("make name"), slug: optionalSlug });
export const modelInput = z.object({
  makeId: z.string().min(1, "Choose a make."),
  name: text("model name"),
  slug: optionalSlug,
  vehicleType: z.enum(["MOTORCYCLE", "SCOOTER"], { message: "Choose motorcycle or scooter." }),
});
export const variantInput = z
  .object({
    modelId: z.string().min(1, "Choose a model."),
    name: text("variant name"),
    yearFrom: year("first year"),
    yearTo: z.union([z.literal(""), year("last year")]).optional().transform((v) => (v === "" || v === undefined ? null : v)),
    engineCc: optionalInt,
  })
  .refine((v) => v.yearTo === null || v.yearTo >= v.yearFrom, { path: ["yearTo"], message: "The last year can't be before the first year." });
export const partNumberInput = z.object({
  display: text("part number", 60).refine((v) => normalizePartNumber(v).length >= 2, "Enter at least 2 letters or digits."),
  brand: text("brand", 60),
  isOem: z.union([z.boolean(), z.literal("on"), z.literal("")]).optional().transform((v) => v === true || v === "on"),
  categoryId: z.string().min(1, "Choose a category."),
});

/** Turns unique-constraint violations into a field error the form can show. */
async function unique<T>(fn: () => Promise<T>, field: string, message: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new FieldError({ [field]: message });
    throw err;
  }
}

async function audit(tx: Tx, actor: Actor, action: string, entity: { type: string; id: string }, before: unknown, after: unknown) {
  await recordAudit(tx, {
    actor: { type: "ADMIN", id: actor.userId },
    action,
    entity,
    before: (before ?? null) as Prisma.InputJsonValue | null,
    after: (after ?? null) as Prisma.InputJsonValue | null,
    requestId: actor.requestId,
  });
}

// ── makes ──
export const listMakes = (db: Pick<Db, "vehicleMake">) =>
  db.vehicleMake.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { models: true } } } });

export async function saveMake(db: Db, actor: Actor, input: RawInput) {
  const data = makeInput.parse(input);
  const values = { name: data.name, slug: data.slug || slugify(data.name) };
  return db.$transaction((tx) =>
    unique(async () => {
      const before = input.id ? await tx.vehicleMake.findUnique({ where: { id: input.id } }) : null;
      if (input.id && !before) throw new NotFoundError("make");
      const row = input.id ? await tx.vehicleMake.update({ where: { id: input.id }, data: values }) : await tx.vehicleMake.create({ data: values });
      await audit(tx, actor, input.id ? "catalogue.make_updated" : "catalogue.make_created", { type: "VehicleMake", id: row.id }, before, row);
      return row;
    }, "name", "A make with this name or slug already exists."),
  );
}

export async function deleteMake(db: Db, actor: Actor, id: string) {
  await db.$transaction(async (tx) => {
    const row = await tx.vehicleMake.findUnique({ where: { id }, include: { _count: { select: { models: true } } } });
    if (!row) throw new NotFoundError("make");
    if (row._count.models > 0) throw new UserError(`${row.name} still has ${row._count.models} model(s). Delete or move them first.`);
    await tx.vehicleMake.delete({ where: { id } });
    await audit(tx, actor, "catalogue.make_deleted", { type: "VehicleMake", id }, { name: row.name, slug: row.slug }, null);
  });
}

// ── models ──
export const listModels = (db: Pick<Db, "vehicleModel">) =>
  db.vehicleModel.findMany({ orderBy: [{ make: { name: "asc" } }, { name: "asc" }], include: { make: true, _count: { select: { variants: true } } } });

export async function saveModel(db: Db, actor: Actor, input: RawInput) {
  const data = modelInput.parse(input);
  const values = { makeId: data.makeId, name: data.name, slug: data.slug || slugify(data.name), vehicleType: data.vehicleType };
  return db.$transaction((tx) =>
    unique(async () => {
      if (!(await tx.vehicleMake.findUnique({ where: { id: data.makeId } }))) throw new FieldError({ makeId: "Choose a make from the list." });
      const before = input.id ? await tx.vehicleModel.findUnique({ where: { id: input.id } }) : null;
      if (input.id && !before) throw new NotFoundError("model");
      const row = input.id ? await tx.vehicleModel.update({ where: { id: input.id }, data: values }) : await tx.vehicleModel.create({ data: values });
      await audit(tx, actor, input.id ? "catalogue.model_updated" : "catalogue.model_created", { type: "VehicleModel", id: row.id }, before, row);
      return row;
    }, "name", "This make already has a model with this slug."),
  );
}

export async function deleteModel(db: Db, actor: Actor, id: string) {
  await db.$transaction(async (tx) => {
    const row = await tx.vehicleModel.findUnique({ where: { id }, include: { _count: { select: { variants: true } } } });
    if (!row) throw new NotFoundError("model");
    if (row._count.variants > 0) throw new UserError(`${row.name} still has ${row._count.variants} variant(s). Delete them first.`);
    await tx.vehicleModel.delete({ where: { id } });
    await audit(tx, actor, "catalogue.model_deleted", { type: "VehicleModel", id }, { name: row.name, makeId: row.makeId }, null);
  });
}

// ── variants ──
export const listVariants = (db: Pick<Db, "vehicleVariant">) =>
  db.vehicleVariant.findMany({
    orderBy: [{ model: { make: { name: "asc" } } }, { model: { name: "asc" } }, { name: "asc" }, { yearFrom: "asc" }],
    include: { model: { include: { make: true } }, _count: { select: { fitments: true, garageEntries: true } } },
  });

export async function saveVariant(db: Db, actor: Actor, input: RawInput) {
  const data = variantInput.parse(input);
  return db.$transaction((tx) =>
    unique(async () => {
      if (!(await tx.vehicleModel.findUnique({ where: { id: data.modelId } }))) throw new FieldError({ modelId: "Choose a model from the list." });
      const before = input.id ? await tx.vehicleVariant.findUnique({ where: { id: input.id } }) : null;
      if (input.id && !before) throw new NotFoundError("variant");
      const row = input.id ? await tx.vehicleVariant.update({ where: { id: input.id }, data }) : await tx.vehicleVariant.create({ data });
      await audit(tx, actor, input.id ? "catalogue.variant_updated" : "catalogue.variant_created", { type: "VehicleVariant", id: row.id }, before, row);
      return row;
    }, "name", "This model already has a variant with this name starting in that year."),
  );
}

export async function deleteVariant(db: Db, actor: Actor, id: string) {
  await db.$transaction(async (tx) => {
    const row = await tx.vehicleVariant.findUnique({ where: { id }, include: { _count: { select: { fitments: true, garageEntries: true } } } });
    if (!row) throw new NotFoundError("variant");
    if (row._count.fitments + row._count.garageEntries > 0) {
      throw new UserError(`${row.name} is used by ${row._count.fitments} fitment(s) and ${row._count.garageEntries} garage bike(s), so it can't be deleted.`);
    }
    await tx.vehicleVariant.delete({ where: { id } });
    await audit(tx, actor, "catalogue.variant_deleted", { type: "VehicleVariant", id }, { name: row.name, modelId: row.modelId, yearFrom: row.yearFrom }, null);
  });
}

// ── part numbers ──
export function listPartNumbers(db: Pick<Db, "partNumber">, q?: string) {
  const normalized = q ? normalizePartNumber(q) : "";
  return db.partNumber.findMany({
    where: normalized ? { OR: [{ normalized: { contains: normalized } }, { brand: { contains: q!.trim(), mode: "insensitive" } }] } : undefined,
    orderBy: [{ brand: "asc" }, { normalized: "asc" }],
    include: { category: { select: { name: true } }, _count: { select: { fitments: true, listings: true, linksAsA: true, linksAsB: true } } },
    take: 200,
  });
}

export async function savePartNumber(db: Db, actor: Actor, input: RawInput) {
  const data = partNumberInput.parse(input);
  const values = { display: data.display, normalized: normalizePartNumber(data.display), brand: data.brand, isOem: data.isOem, categoryId: data.categoryId };
  return db.$transaction((tx) =>
    unique(async () => {
      if (!(await tx.partCategory.findUnique({ where: { id: data.categoryId } }))) throw new FieldError({ categoryId: "Choose a category from the list." });
      const before = input.id ? await tx.partNumber.findUnique({ where: { id: input.id } }) : null;
      if (input.id && !before) throw new NotFoundError("part number");
      const row = input.id ? await tx.partNumber.update({ where: { id: input.id }, data: values }) : await tx.partNumber.create({ data: values });
      await audit(tx, actor, input.id ? "catalogue.part_number_updated" : "catalogue.part_number_created", { type: "PartNumber", id: row.id }, before, row);
      return row;
    }, "display", "This brand already has this part number (spaces and dashes are ignored)."),
  );
}

export async function deletePartNumber(db: Db, actor: Actor, id: string) {
  await db.$transaction(async (tx) => {
    const row = await tx.partNumber.findUnique({ where: { id }, include: { _count: { select: { fitments: true, listings: true, linksAsA: true, linksAsB: true } } } });
    if (!row) throw new NotFoundError("part number");
    const c = row._count;
    if (c.fitments + c.listings + c.linksAsA + c.linksAsB > 0) {
      throw new UserError(`${row.display} is used by ${c.listings} listing(s), ${c.fitments} fitment(s) and ${c.linksAsA + c.linksAsB} interchange link(s), so it can't be deleted.`);
    }
    await tx.partNumber.delete({ where: { id } });
    await audit(tx, actor, "catalogue.part_number_deleted", { type: "PartNumber", id }, { display: row.display, brand: row.brand }, null);
  });
}
