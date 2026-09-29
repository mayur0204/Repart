"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { publicSearch } from "@/server/services";

/** Save / unsave a listing (members). */
export const toggleSaveListing = defineAction({ input: z.object({ listingId: z.string().min(1) }), access: "member" }, async (input, ctx) => {
  const saved = await publicSearch.toggleSaved(ctx.user.id, input.listingId);
  revalidatePath(`/listings/${input.listingId}`);
  revalidatePath("/account/saved");
  return { ok: true, message: saved ? "Saved to your list" : "Removed from your list" };
});

/** Report a listing to RePart's team (members). */
export const reportListing = defineAction(
  { input: z.object({ listingId: z.string().min(1), reason: z.string().default(""), details: z.string().optional() }), access: "member" },
  async (input, ctx) => {
    await publicSearch.report(ctx.user.id, input);
    return { ok: true, message: "Report sent. Our team will review this listing." };
  },
);
