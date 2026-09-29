"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { LISTING_STEPS, stepNumber, type StepSlug } from "@/lib/listing";
import { defineAction } from "@/server/http/define-action";
import { listings, photos } from "@/server/services";

/** Listing wizard actions (PLAN.md §4.4). Every service call checks the caller owns the listing. */
const actor = (ctx: { user: { id: string }; requestId: string }) => ({ userId: ctx.user.id, requestId: ctx.requestId });
const listingId = z.string().min(1);
const asArray = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]));

/** Save-and-continue: after saving a step, go to the next one (or stay, for "Save draft"). */
function continueFrom(id: string, step: StepSlug, intent?: string) {
  revalidatePath(`/sell/${id}`, "layout");
  if (intent === "stay") return { ok: true, message: "Draft saved" };
  redirect(`/sell/${id}/${LISTING_STEPS[stepNumber(step)]!.slug}`);
}

export const startListing = defineAction({ input: z.object({}), access: "member" }, async (_input, ctx) => {
  const draft = await listings.createDraft(actor(ctx));
  redirect(`/sell/${draft.id}/bike`);
});

export const saveBike = defineAction(
  { input: z.object({ listingId, source: z.enum(["garage", "catalogue"]), garageVehicleId: z.string().optional(), variantId: z.string().optional(), intent: z.string().optional() }), access: "member" },
  async (input, ctx) => {
    await listings.saveBike(actor(ctx), input.listingId, input.source === "garage" ? { garageVehicleId: input.garageVehicleId ?? "" } : { variantId: input.variantId ?? "" });
    return continueFrom(input.listingId, "bike", input.intent);
  },
);

export const savePart = defineAction(
  { input: z.object({ listingId, partNumberId: z.string().default(""), partName: z.string().default(""), confirmedVariantIds: asArray, intent: z.string().optional() }), access: "member" },
  async ({ listingId: id, intent, ...input }, ctx) => {
    await listings.savePart(actor(ctx), id, input);
    return continueFrom(id, "part", intent);
  },
);

export const saveCondition = defineAction({ input: z.record(z.string(), z.unknown()), access: "member" }, async (input, ctx) => {
  const id = String(input.listingId ?? "");
  const answers = Object.fromEntries(Object.entries(input).filter(([k]) => k.startsWith("q_")).map(([k, v]) => [k.slice(2), v]));
  await listings.saveCondition(actor(ctx), id, answers);
  return continueFrom(id, "condition", typeof input.intent === "string" ? input.intent : undefined);
});

export const continueFromPhotos = defineAction({ input: z.object({ listingId }), access: "member" }, async (input) => {
  redirect(`/sell/${input.listingId}/details`);
});

export const saveDetails = defineAction(
  { input: z.object({ listingId, kmUsedApprox: z.string().optional(), reasonForSale: z.string().optional(), description: z.string().default(""), intent: z.string().optional() }), access: "member" },
  async ({ listingId: id, intent, ...input }, ctx) => {
    await listings.saveDetails(actor(ctx), id, input);
    return continueFrom(id, "details", intent);
  },
);

export const savePrice = defineAction(
  {
    input: z.object({
      listingId,
      priceRupees: z.string().default(""),
      pickupAddressId: z.string().default(""),
      weightBand: z.string().default(""),
      dimensionBand: z.string().default(""),
      fulfilmentMode: z.string().default(""),
      intent: z.string().optional(),
    }),
    access: "member",
  },
  async ({ listingId: id, intent, ...input }, ctx) => {
    await listings.savePrice(actor(ctx), id, input);
    return continueFrom(id, "price", intent);
  },
);

export const submitListing = defineAction({ input: z.object({ listingId }), access: "member" }, async (input, ctx) => {
  const problems = await listings.submit(actor(ctx), input.listingId);
  if (problems) return { ok: false, message: "Some steps aren't finished yet. They're listed below." };
  revalidatePath("/seller");
  redirect(`/sell/${input.listingId}/status`);
});

export const withdrawListing = defineAction({ input: z.object({ listingId }), access: "member" }, async (input, ctx) => {
  await listings.withdraw(actor(ctx), input.listingId);
  revalidatePath("/seller");
  return { ok: true, message: "Listing withdrawn" };
});

// ── photos: called directly by the uploader component ──
export const requestPhotoUpload = defineAction(
  { input: z.object({ listingId, shotType: z.string().min(1), size: z.coerce.number(), type: z.string() }), access: "member" },
  async (input, ctx) => {
    const slot = await photos.requestUpload(actor(ctx), input);
    return { ok: true, data: slot };
  },
);

export const confirmPhotoUpload = defineAction({ input: z.object({ photoId: z.string().min(1) }), access: "member" }, async (input, ctx) => {
  await photos.confirmUpload(actor(ctx), input.photoId);
  return { ok: true };
});

export const removePhoto = defineAction({ input: z.object({ photoId: z.string().min(1) }), access: "member" }, async (input, ctx) => {
  await photos.remove(actor(ctx), input.photoId);
  return { ok: true, message: "Photo removed" };
});

export const movePhoto = defineAction({ input: z.object({ photoId: z.string().min(1), to: z.enum(["up", "down", "first"]) }), access: "member" }, async (input, ctx) => {
  await photos.move(actor(ctx), input.photoId, input.to);
  return { ok: true };
});
