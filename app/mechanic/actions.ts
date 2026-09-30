"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { inspections } from "@/server/services";

/** Mechanic portal actions (PLAN.md §4.7). The service checks the job belongs to the mechanic's garage. */
const MECHANIC = ["MECHANIC"] as const;
const id = z.string().min(1).max(64);

export const requestInspectionPhoto = defineAction(
  { input: z.object({ inspectionId: id, shotType: z.string().min(1).max(40), size: z.coerce.number().int(), type: z.string().max(40) }), access: MECHANIC },
  async (input, ctx) => {
    const r = await inspections.requestPhoto({ userId: ctx.user.id, requestId: ctx.requestId }, input);
    return { ok: true, data: r };
  },
);

export const confirmInspectionPhoto = defineAction({ input: z.object({ photoId: id }), access: MECHANIC }, async (input, ctx) => {
  const r = await inspections.confirmPhoto({ userId: ctx.user.id, requestId: ctx.requestId }, input.photoId);
  return r === "ready" ? { ok: true } : { ok: false, message: "That file couldn't be used. Try another photo." };
});

/** "Submit inspection" (brief §10 wording). */
export const submitInspection = defineAction({ input: z.record(z.string(), z.string()), access: MECHANIC }, async (input, ctx) => {
  const inspectionId = input.inspectionId ?? "";
  await inspections.submit({ userId: ctx.user.id, requestId: ctx.requestId }, inspectionId, input);
  revalidatePath("/mechanic");
  redirect(`/mechanic/jobs/${encodeURIComponent(inspectionId)}`);
});
