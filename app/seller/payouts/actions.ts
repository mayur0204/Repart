"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { payouts } from "@/server/services";

/**
 * Payout onboarding (M8). Fields are passed as-is to the service, which validates them with Zod.
 * Bank / UPI / KYC values go straight to the payment provider and are never stored or logged.
 */
export const submitPayoutDetails = defineAction({ input: z.record(z.string(), z.string()), access: "member" }, async (input, ctx) => {
  const s = await payouts.submit({ userId: ctx.user.id, requestId: ctx.requestId }, input);
  revalidatePath("/seller/payouts");
  return { ok: true, message: s.eligible ? "Payout account active" : "Details submitted. We'll show the status here." };
});
