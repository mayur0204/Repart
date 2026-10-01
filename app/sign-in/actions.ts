"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNext, withNext } from "@/lib/return-to";
import { endCurrentSession, needsOnboardingById } from "@/server/auth/current";
import { createSupabaseServerClient } from "@/server/auth/supabase";
import { env } from "@/server/env";
import { defineAction } from "@/server/http/define-action";
import { UserError } from "@/server/http/errors";
import { emailAuth, garage, profile } from "@/server/services";
import { isConsentPurpose } from "@/server/services/consent/consent";

const next = z.string().optional();

/** Supabase Auth for this request. Identity only: roles and status come from the RePart User. */
async function supabaseAuth() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new UserError("Email sign-in isn't set up on this server yet.");
  return supabase.auth;
}

const credentials = { email: z.string().default(""), password: z.string().default(""), next };

export const signInWithPassword = defineAction({ input: z.object(credentials), access: "public" }, async (input) => {
  const result = await emailAuth.signIn(await supabaseAuth(), input);
  if (result.status === "needs-phone") redirect(withNext("/sign-in/finish-account", input.next));
  if (await needsOnboardingById(result.userId)) redirect(withNext("/sign-in/about-you", input.next));
  redirect(safeNext(input.next));
});

/** One-time phone step for a signed-in Supabase login that has no RePart User yet. */
export const finishAccount = defineAction({ input: z.object({ phone: z.string().default(""), next }), access: "public" }, async (input) => {
  const { data } = await (await supabaseAuth()).getClaims();
  if (!data?.claims) redirect(withNext("/sign-in", input.next));
  const { userId } = await emailAuth.finishAccount({ id: data.claims.sub, email: data.claims.email }, input);
  if (await needsOnboardingById(userId)) redirect(withNext("/sign-in/about-you", input.next));
  redirect(safeNext(input.next));
});

export const createAccount = defineAction({ input: z.object({ ...credentials, phone: z.string().default("") }), access: "public" }, async (input, ctx) => {
  // The confirmation link (when email confirmation is on) returns to this deployment, local or Vercel Preview.
  const origin = (await headers()).get("origin") ?? env().APP_BASE_URL;
  const result = await emailAuth.signUp(await supabaseAuth(), input, { ip: ctx.ip, emailRedirectTo: withNext(`${origin}/auth/callback`, input.next) });
  if (result.status === "check-email") return { ok: true, message: "Check your email for a confirmation link, then sign in." };
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
