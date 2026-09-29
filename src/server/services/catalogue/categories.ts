import "server-only";
import { z } from "zod";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { SLUG_PATTERN, slugify } from "@/lib/slug";
import { FieldError, NotFoundError, UserError } from "../../http/errors";
import { recordAudit } from "../audit/audit";

/**
 * Part categories: tiers, thresholds, fees, checklists and photo guides (PLAN.md §4.8).
 * Admin forms enter money in rupees; it is stored in paise. Edits are audited with before/after.
 */
type Db = PrismaClient;
type Actor = { userId: string; requestId?: string };

export const checklistItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, "Checklist ids use lowercase letters, digits and underscores."),
  question: z.string().min(5).max(200),
  weight: z.number().int().min(0).max(100),
  badAnswer: z.enum(["YES", "NO"]),
  blocksListing: z.boolean(),
});
export const photoShotSchema = z.object({
  shotType: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string().min(2).max(80),
  instructions: z.string().min(5).max(300),
  required: z.boolean(),
});

const jsonArray = <T extends z.ZodType>(item: T, what: string) =>
  z.string().transform((v, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      ctx.addIssue({ code: "custom", message: `The ${what} isn't valid JSON. Check brackets, quotes and commas.` });
      return z.NEVER;
    }
    const result = z.array(item).min(1, `Add at least one ${what} item.`).safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0]!;
      ctx.addIssue({ code: "custom", message: `${what} item ${String(issue.path[0] ?? "")}: ${issue.path.slice(1).join(".")} ${issue.message}`.trim() });
      return z.NEVER;
    }
    const ids = result.data.map((i) => (i as { id?: string; shotType?: string }).id ?? (i as { shotType?: string }).shotType);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: `Each ${what} item needs a unique id.` });
      return z.NEVER;
    }
    return result.data as z.infer<T>[];
  });

const rupeesToPaise = z
  .union([z.literal(""), z.coerce.number().min(0, "Enter zero or more.").max(1_000_000)])
  .optional()
  .transform((v) => (v === "" || v === undefined ? null : Math.round(v * 100)));

const checkbox = z.union([z.literal("on"), z.literal(""), z.boolean()]).optional().transform((v) => v === true || v === "on");

export const categoryInput = z
  .object({
    name: z.string().trim().min(2, "Enter the category name.").max(80),
    slug: z.string().trim().optional().refine((v) => !v || SLUG_PATTERN.test(v), "Use lowercase letters, digits and single dashes."),
    parentId: z.string().optional().transform((v) => (v ? v : null)),
    sortOrder: z.coerce.number().int().min(0).max(10_000).default(0),
    isSafetyCritical: checkbox,
    inspectionTier: z.enum(["A_AUTOMATED", "B_CONDITIONAL", "C_ALWAYS"]),
    inspectionValueThresholdRupees: rupeesToPaise,
    optionalCheckFeeRupees: rupeesToPaise,
    optionalCheckEnabled: checkbox,
    shippingRestriction: z.enum(["NONE", "FRAGILE", "OVERSIZE", "NOT_SHIPPABLE"]),
    packagingGuide: z.string().trim().min(10, "Describe how to pack parts in this category.").max(2000),
    partNumberHint: z.string().trim().max(300).optional().transform((v) => (v ? v : null)),
    conditionChecklist: jsonArray(checklistItemSchema, "checklist"),
    photoGuide: jsonArray(photoShotSchema, "photo guide"),
  })
  .superRefine((v, ctx) => {
    if (v.inspectionTier === "B_CONDITIONAL" && v.inspectionValueThresholdRupees === null) {
      ctx.addIssue({ code: "custom", path: ["inspectionValueThresholdRupees"], message: "Tier B needs a price above which inspection is required." });
    }
    if (v.isSafetyCritical && v.inspectionTier === "A_AUTOMATED") {
      ctx.addIssue({ code: "custom", path: ["inspectionTier"], message: "Safety-critical categories need Tier B or C inspection." });
    }
  });

export const listCategories = (db: Pick<Db, "partCategory">) =>
  db.partCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], include: { parent: { select: { name: true } }, _count: { select: { partNumbers: true, listings: true, children: true } } } });

export async function getCategory(db: Pick<Db, "partCategory">, id: string) {
  const row = await db.partCategory.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("category");
  return row;
}

export async function saveCategory(db: Db, actor: Actor, input: Record<string, unknown> & { id?: string }) {
  const d = categoryInput.parse(input);
  if (input.id && d.parentId === input.id) throw new FieldError({ parentId: "A category can't be its own parent." });
  const values = {
    name: d.name,
    slug: d.slug || slugify(d.name),
    parentId: d.parentId,
    sortOrder: d.sortOrder,
    isSafetyCritical: d.isSafetyCritical,
    inspectionTier: d.inspectionTier,
    inspectionValueThreshold: d.inspectionTier === "B_CONDITIONAL" ? d.inspectionValueThresholdRupees : null,
    optionalCheckFee: d.optionalCheckFeeRupees ?? 0,
    optionalCheckEnabled: d.optionalCheckEnabled,
    shippingRestriction: d.shippingRestriction,
    packagingGuide: d.packagingGuide,
    partNumberHint: d.partNumberHint,
    conditionChecklist: d.conditionChecklist as Prisma.InputJsonValue,
    photoGuide: d.photoGuide as Prisma.InputJsonValue,
  };
  try {
    return await db.$transaction(async (tx) => {
      const before = input.id ? await tx.partCategory.findUnique({ where: { id: input.id } }) : null;
      if (input.id && !before) throw new NotFoundError("category");
      if (values.parentId && !(await tx.partCategory.findUnique({ where: { id: values.parentId } }))) throw new FieldError({ parentId: "Choose a parent from the list." });
      const row = input.id ? await tx.partCategory.update({ where: { id: input.id }, data: values }) : await tx.partCategory.create({ data: values });
      await recordAudit(tx, {
        actor: { type: "ADMIN", id: actor.userId },
        action: input.id ? "category.updated" : "category.created",
        entity: { type: "PartCategory", id: row.id },
        before: before as unknown as Prisma.InputJsonValue,
        after: row as unknown as Prisma.InputJsonValue,
        requestId: actor.requestId,
      });
      return row;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new FieldError({ slug: "Another category already uses this slug." });
    throw err;
  }
}

export async function deleteCategory(db: Db, actor: Actor, id: string) {
  await db.$transaction(async (tx) => {
    const row = await tx.partCategory.findUnique({ where: { id }, include: { _count: { select: { partNumbers: true, listings: true, children: true } } } });
    if (!row) throw new NotFoundError("category");
    const c = row._count;
    if (c.partNumbers + c.listings + c.children > 0) {
      throw new UserError(`${row.name} has ${c.partNumbers} part number(s), ${c.listings} listing(s) and ${c.children} sub-categories, so it can't be deleted.`);
    }
    await tx.partCategory.delete({ where: { id } });
    await recordAudit(tx, { actor: { type: "ADMIN", id: actor.userId }, action: "category.deleted", entity: { type: "PartCategory", id }, before: { name: row.name, slug: row.slug }, requestId: actor.requestId });
  });
}
