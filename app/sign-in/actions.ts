"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNext, withNext } from "@/lib/return-to";
import { clearOtpChallengeCookie, readOtpChallengeId, setOtpChallengeCookie, setSessionCookie } from "@/server/auth/cookies";
import { endCurrentSession, needsOnboardingById, userAgent } from "@/server/auth/current";
import { defineAction } from "@/server/http/define-action";
import { UserError } from "@/server/http/errors";
import { garage, profile, signIn } from "@/server/services";
import { isConsentPurpose } from "@/server/services/consent/consent";

const next = z.string().optional();

export const requestCode = defineAction({ input: z.object({ phone: z.string().default(""), next }), access: "public" }, async (input, ctx) => {
  const { challengeId } = await signIn.start({ phone: input.phone, ip: ctx.ip });
  await setOtpChallengeCookie(challengeId);
  redirect(withNext("/sign-in/verify", input.next));
});

export const resendCode = defineAction({ input: z.object({}), access: "public" }, async (_input, ctx) => {
  const challengeId = await readOtpChallengeId();
  if (!challengeId) throw new UserError("Start again by entering your phone number.");
  const fresh = await signIn.resend({ challengeId, ip: ctx.ip });
  await setOtpChallengeCookie(fresh.challengeId);
  return { ok: true, message: "New code sent" };
});

export const verifyCode = defineAction({ input: z.object({ code: z.string().trim().default(""), next }), access: "public" }, async (input) => {
  const challengeId = await readOtpChallengeId();
  if (!challengeId) throw new UserError("Your code request has expired. Enter your phone number again.");
  const result = await signIn.verify({ challengeId, code: input.code, userAgent: await userAgent() });
  await setSessionCookie(result.token);
  await clearOtpChallengeCookie();

  if (await needsOnboardingById(result.userId)) redirect(withNext("/sign-in/about-you", input.next));
  redirect(safeNext(input.next));
});

export const completeAboutYou = defineAction(
  {
    input: z.object({
      name: z.string().default(""),
      email: z.string().default(""),
      optionalConsents: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).filter(isConsentPurpose)),
      next,
    }),
    access: "member",
  },
  async (input, ctx) => {
    await profile.completeAboutYou({ userId: ctx.user.id, requestId: ctx.requestId }, input);
    const hasBike = (await garage.count(ctx.user.id)) > 0;
    redirect(hasBike ? safeNext(input.next) : withNext("/sign-in/add-bike", input.next));
  },
);

export const addFirstBike = defineAction(
  { input: z.object({ variantId: z.string().default(""), year: z.string().default(""), nickname: z.string().optional(), next }), access: "member" },
  async (input, ctx) => {
    await garage.add(ctx.user.id, input);
    redirect(safeNext(input.next));
  },
);

export const signOut = defineAction({ input: z.object({}), access: "public" }, async () => {
  await endCurrentSession();
  redirect("/");
});
