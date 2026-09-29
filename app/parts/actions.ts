"use server";

import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { interchange } from "@/server/services";

/** "Suggest an equivalent part number" (PLAN.md §6.6): signed-in members, rate limited, reviewed by admins. */
export const suggestEquivalent = defineAction(
  {
    input: z.object({
      fromPartNumberId: z.string().default(""),
      brand: z.string().default(""),
      number: z.string().default(""),
      type: z.string().default(""),
      notes: z.string().optional(),
    }),
    access: "member",
  },
  async (input, ctx) => {
    await interchange.suggest({ userId: ctx.user.id, requestId: ctx.requestId }, input);
    return { ok: true, message: "Suggestion sent for review. Thanks." };
  },
);
