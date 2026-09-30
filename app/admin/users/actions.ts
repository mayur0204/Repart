"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { admin } from "@/server/services";

/** Role grants/revocations and suspend/unsuspend (PLAN.md §4.8, A-19). All audited; the last active admin is protected. */
const ADMIN = ["ADMIN"] as const;

export const changeUserRole = defineAction(
  { input: z.object({ userId: z.string().min(1).max(64), role: z.string().max(20), grant: z.string().max(5) }), access: ADMIN },
  async (input, ctx) => {
    await admin.changeRole({ userId: ctx.user.id, requestId: ctx.requestId }, input);
    revalidatePath(`/admin/users/${input.userId}`);
    return { ok: true, message: input.grant === "true" ? `${input.role.toLowerCase()} role granted` : `${input.role.toLowerCase()} role removed` };
  },
);

export const changeUserStatus = defineAction(
  { input: z.object({ userId: z.string().min(1).max(64), status: z.string().max(20), reason: z.string().max(300).optional() }), access: ADMIN },
  async (input, ctx) => {
    await admin.changeStatus({ userId: ctx.user.id, requestId: ctx.requestId }, { ...input, reason: input.reason ?? "" });
    revalidatePath(`/admin/users/${input.userId}`);
    return { ok: true, message: input.status === "SUSPENDED" ? "Account suspended" : "Account restored" };
  },
);
