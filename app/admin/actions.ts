"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { UserError } from "@/server/http/errors";
import { catalogueAdminService as catalogue, categories, imports, interchange, risk, settings } from "@/server/services";

/** Admin-only catalogue, category, import and interchange actions (PLAN.md §4.8, M3). */
const ADMIN = ["ADMIN"] as const;
const optionalId = z.string().optional().transform((v) => (v ? v : undefined));
const id = z.object({ id: z.string().min(1) });
const actor = (ctx: { user: { id: string }; requestId: string }) => ({ userId: ctx.user.id, requestId: ctx.requestId });
const saved = (path: string) => {
  revalidatePath(path);
  redirect(path);
};
const deleted = (path: string, what: string) => {
  revalidatePath(path);
  return { ok: true, message: `${what} deleted` };
};

// ── makes / models / variants / part numbers ──
export const saveMake = defineAction({ input: z.object({ id: optionalId, name: z.string().default(""), slug: z.string().optional() }), access: ADMIN }, async (input, ctx) => {
  await catalogue.saveMake(actor(ctx), input);
  saved("/admin/catalogue/makes");
});
export const deleteMake = defineAction({ input: id, access: ADMIN }, async (input, ctx) => {
  await catalogue.deleteMake(actor(ctx), input.id);
  return deleted("/admin/catalogue/makes", "Make");
});

export const saveModel = defineAction(
  { input: z.object({ id: optionalId, makeId: z.string().default(""), name: z.string().default(""), slug: z.string().optional(), vehicleType: z.string().default("") }), access: ADMIN },
  async (input, ctx) => {
    await catalogue.saveModel(actor(ctx), input);
    saved("/admin/catalogue/models");
  },
);
export const deleteModel = defineAction({ input: id, access: ADMIN }, async (input, ctx) => {
  await catalogue.deleteModel(actor(ctx), input.id);
  return deleted("/admin/catalogue/models", "Model");
});

export const saveVariant = defineAction(
  {
    input: z.object({ id: optionalId, modelId: z.string().default(""), name: z.string().default(""), yearFrom: z.string().default(""), yearTo: z.string().optional(), engineCc: z.string().optional() }),
    access: ADMIN,
  },
  async (input, ctx) => {
    await catalogue.saveVariant(actor(ctx), input);
    saved("/admin/catalogue/variants");
  },
);
export const deleteVariant = defineAction({ input: id, access: ADMIN }, async (input, ctx) => {
  await catalogue.deleteVariant(actor(ctx), input.id);
  return deleted("/admin/catalogue/variants", "Variant");
});

export const savePartNumber = defineAction(
  { input: z.object({ id: optionalId, display: z.string().default(""), brand: z.string().default(""), isOem: z.string().optional(), categoryId: z.string().default("") }), access: ADMIN },
  async (input, ctx) => {
    await catalogue.savePartNumber(actor(ctx), input);
    saved("/admin/catalogue/part-numbers");
  },
);
export const deletePartNumber = defineAction({ input: id, access: ADMIN }, async (input, ctx) => {
  await catalogue.deletePartNumber(actor(ctx), input.id);
  return deleted("/admin/catalogue/part-numbers", "Part number");
});

// ── categories ──
export const saveCategory = defineAction({ input: z.record(z.string(), z.unknown()), access: ADMIN }, async (input, ctx) => {
  const { id: categoryId, ...fields } = input;
  await categories.save(actor(ctx), { ...fields, id: typeof categoryId === "string" && categoryId ? categoryId : undefined });
  saved("/admin/categories");
});
export const deleteCategory = defineAction({ input: id, access: ADMIN }, async (input, ctx) => {
  await categories.remove(actor(ctx), input.id);
  return deleted("/admin/categories", "Category");
});

// ── CSV import ──
const importKinds = ["MAKES", "MODELS", "VARIANTS", "PART_NUMBERS", "INTERCHANGE", "FITMENTS"] as const;
export const uploadImport = defineAction(
  { input: z.object({ kind: z.enum(importKinds, { message: "Choose what the file contains." }), file: z.instanceof(File, { message: "Choose a CSV file." }) }), access: ADMIN, files: true },
  async (input, ctx) => {
    if (input.file.size === 0) throw new UserError("Choose a CSV file.");
    if (!/\.csv$/i.test(input.file.name) && input.file.type !== "text/csv") throw new UserError("Upload a .csv file.");
    const row = await imports.create(actor(ctx), { kind: input.kind, fileName: input.file.name, content: await input.file.text() });
    revalidatePath("/admin/catalogue/import");
    redirect(`/admin/catalogue/import/${row.id}`);
  },
);
export const applyImport = defineAction({ input: id, access: ADMIN }, async (input, ctx) => {
  const report = await imports.apply(actor(ctx), input.id);
  revalidatePath(`/admin/catalogue/import/${input.id}`);
  return { ok: true, message: `Import applied: ${report.counts.create} created, ${report.counts.update} updated` };
});

// ── interchange ──
export const createLink = defineAction(
  {
    input: z.object({
      aBrand: z.string().default(""),
      aNumber: z.string().default(""),
      bBrand: z.string().default(""),
      bNumber: z.string().default(""),
      type: z.string().default(""),
      source: z.string().default(""),
      notes: z.string().optional(),
    }),
    access: ADMIN,
  },
  async (input, ctx) => {
    await interchange.createLink(actor(ctx), input);
    revalidatePath("/admin/interchange");
    return { ok: true, message: "Link added" };
  },
);
export const reviewLink = defineAction(
  { input: z.object({ id: z.string().min(1), decision: z.enum(["APPROVE", "REJECT", "CLEAR_FLAG"]) }), access: ADMIN },
  async (input, ctx) => {
    await interchange.review(actor(ctx), input);
    revalidatePath("/admin/interchange");
    return { ok: true, message: input.decision === "APPROVE" ? "Link approved" : input.decision === "REJECT" ? "Link rejected" : "Flag cleared" };
  },
);

// ── listing review (M5, PLAN.md §6.1 Stage 3, decision D-5) ──
const decision = z.object({ listingId: z.string().min(1), reason: z.string().default("") });
export const requestListingChanges = defineAction({ input: decision, access: ADMIN }, async (input, ctx) => {
  await risk.requestChanges(actor(ctx), input);
  revalidatePath("/admin/listings");
  redirect(`/admin/listings/${input.listingId}`);
});
export const rejectListing = defineAction({ input: decision, access: ADMIN }, async (input, ctx) => {
  await risk.reject(actor(ctx), input);
  revalidatePath("/admin/listings");
  redirect(`/admin/listings/${input.listingId}`);
});
export const keepListingLive = defineAction({ input: z.object({ listingId: z.string().min(1), note: z.string().optional() }), access: ADMIN }, async (input, ctx) => {
  await risk.clearReview(actor(ctx), input.listingId, input.note);
  revalidatePath("/admin/listings");
  return { ok: true, message: "Kept live and removed from the queue" };
});

// ── settings versions (M5: risk rules are edited as a new settings version) ──
export const createSettingsVersion = defineAction({ input: z.object({ json: z.string().default(""), note: z.string().optional() }), access: ADMIN }, async (input, ctx) => {
  let data: unknown;
  try {
    data = JSON.parse(input.json);
  } catch {
    throw new UserError("The settings aren't valid JSON. Check brackets, quotes and commas.");
  }
  const created = await settings.create({ data, note: input.note, actor: { type: "ADMIN", id: ctx.user.id }, requestId: ctx.requestId });
  revalidatePath("/admin/settings");
  redirect(`/admin/settings/versions/${created.version}`);
});
export const activateSettingsVersion = defineAction({ input: z.object({ version: z.coerce.number().int().positive() }), access: ADMIN }, async (input, ctx) => {
  await settings.activate({ version: input.version, actor: { type: "ADMIN", id: ctx.user.id }, requestId: ctx.requestId });
  revalidatePath("/admin/settings");
  return { ok: true, message: `Version ${input.version} is now active` };
});
