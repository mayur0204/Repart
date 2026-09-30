"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { messaging } from "@/server/services";

/** Messaging actions (M7). Members only; the service checks the caller takes part in the conversation. */
export const startConversation = defineAction({ input: z.object({ listingId: z.string().min(1) }), access: "member" }, async (input, ctx) => {
  redirect(`/messages/${await messaging.start(ctx.user.id, input.listingId)}`);
});

export const sendMessage = defineAction({ input: z.object({ conversationId: z.string().min(1), body: z.string().default("") }), access: "member" }, async (input, ctx) => {
  const message = await messaging.send({ userId: ctx.user.id, requestId: ctx.requestId }, input);
  return { ok: true, data: { message } };
});

export const markConversationRead = defineAction({ input: z.object({ conversationId: z.string().min(1) }), access: "member" }, async (input, ctx) => {
  await messaging.markRead(ctx.user.id, input.conversationId);
  return { ok: true };
});

export const reportMessage = defineAction(
  { input: z.object({ messageId: z.string().min(1), reason: z.string().default(""), details: z.string().optional() }), access: "member" },
  async (input, ctx) => {
    await messaging.report(ctx.user.id, input);
    return { ok: true, message: "Report sent. Our team will review this message." };
  },
);
