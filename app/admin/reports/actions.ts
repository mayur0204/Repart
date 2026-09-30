"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { admin } from "@/server/services";

/** Report moderation (PLAN.md §4.8). Marks the report handled and audits it; it never suspends or removes anything by itself. */
const ADMIN = ["ADMIN"] as const;

export const moderateReport = defineAction(
  { input: z.object({ reportId: z.string().min(1).max(64), decision: z.enum(["ACTIONED", "DISMISSED"]), note: z.string().max(300).optional() }), access: ADMIN },
  async (input, ctx) => {
    await admin.moderateReport({ userId: ctx.user.id, requestId: ctx.requestId }, input.reportId, input.decision, input.note);
    revalidatePath("/admin/reports");
    return { ok: true, message: input.decision === "ACTIONED" ? "Report marked actioned" : "Report dismissed" };
  },
);
