"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { addresses, consent, profile } from "@/server/services";
import { CONSENT_PURPOSE_KEYS, type ConsentPurpose } from "@/server/services/consent/consent";

const id = z.object({ id: z.string().min(1) });
const addressFields = z.object({
  label: z.string().optional(),
  contactName: z.string().default(""),
  contactPhone: z.string().default(""),
  line1: z.string().default(""),
  line2: z.string().optional(),
  landmark: z.string().optional(),
  city: z.string().default(""),
  state: z.string().default(""),
  pincode: z.string().default(""),
});
const purpose = z.object({ purpose: z.enum(CONSENT_PURPOSE_KEYS as [ConsentPurpose, ...ConsentPurpose[]]) });

export const updateProfile = defineAction(
  { input: z.object({ name: z.string().default(""), email: z.string().default("") }), access: "member" },
  async (input, ctx) => {
    await profile.update({ userId: ctx.user.id, requestId: ctx.requestId }, input);
    revalidatePath("/account");
    return { ok: true, message: "Profile saved" };
  },
);

export const createAddress = defineAction(
  { input: addressFields.extend({ makeDefault: z.string().optional() }), access: "member" },
  async (input, ctx) => {
    await addresses.create(ctx.user.id, { ...input, makeDefault: input.makeDefault === "on" });
    revalidatePath("/account/addresses");
    redirect("/account/addresses");
  },
);

export const updateAddress = defineAction({ input: addressFields.extend(id.shape), access: "member" }, async ({ id: addressId, ...input }, ctx) => {
  await addresses.update(ctx.user.id, addressId, input);
  revalidatePath("/account/addresses");
  redirect("/account/addresses");
});

export const setDefaultAddress = defineAction({ input: id, access: "member" }, async (input, ctx) => {
  await addresses.setDefault(ctx.user.id, input.id);
  revalidatePath("/account/addresses");
  return { ok: true, message: "Default address changed" };
});

export const deleteAddress = defineAction({ input: id, access: "member" }, async (input, ctx) => {
  await addresses.remove(ctx.user.id, input.id);
  revalidatePath("/account/addresses");
  return { ok: true, message: "Address deleted" };
});

export const grantConsent = defineAction({ input: purpose, access: "member" }, async (input, ctx) => {
  await consent.grant({ userId: ctx.user.id, requestId: ctx.requestId }, [input.purpose]);
  revalidatePath("/account/privacy");
  return { ok: true, message: "Consent given" };
});

export const withdrawConsent = defineAction({ input: purpose, access: "member" }, async (input, ctx) => {
  await consent.withdraw({ userId: ctx.user.id, requestId: ctx.requestId }, input.purpose);
  revalidatePath("/account/privacy");
  return { ok: true, message: "Consent withdrawn" };
});

export const requestPersonalData = defineAction(
  { input: z.object({ kind: z.enum(["copy", "delete"]) }), access: "member" },
  async (input, ctx) => {
    await profile.requestPersonalData({ userId: ctx.user.id, requestId: ctx.requestId }, input.kind);
    return {
      ok: true,
      message:
        input.kind === "copy"
          ? "Request received. We'll review it and contact you about your data."
          : "Deletion request received. We'll review it and contact you.",
    };
  },
);
