import "server-only";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { recordAudit } from "../audit/audit";
import { CONSENT_PURPOSES, grantConsents, type ConsentPurpose } from "../consent/consent";

/** Profile and the about-you onboarding step (REPART_BRIEF.md §9). */
type Db = Pick<PrismaClient, "$transaction" | "user" | "consentRecord">;
type Actor = { userId: string; requestId?: string };

export const profileInput = z.object({
  name: z.string().trim().min(2, "Enter your name (at least 2 letters).").max(80, "Keep your name under 80 characters."),
  email: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v === "" ? null : v.toLowerCase()))
    .pipe(z.email("Enter a valid email address, or leave it empty.").nullable()),
});

export type ProfileInput = z.input<typeof profileInput>;

/** Saves name/email and records consent: the required purpose plus any optional ones ticked. */
export async function completeAboutYou(db: Db, actor: Actor, input: ProfileInput & { optionalConsents: ConsentPurpose[] }) {
  const profile = profileInput.parse(input);
  const optional = input.optionalConsents.filter((p) => !CONSENT_PURPOSES[p].required);
  const required = (Object.keys(CONSENT_PURPOSES) as ConsentPurpose[]).filter((p) => CONSENT_PURPOSES[p].required);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: actor.userId }, data: profile });
    await grantConsents(db, actor, [...required, ...optional], tx);
  });
}

export async function updateProfile(db: Db, actor: Actor, input: ProfileInput) {
  const profile = profileInput.parse(input);
  await db.user.update({ where: { id: actor.userId }, data: profile });
}

/** Records a request for a copy or deletion of personal data. Reviewed and fulfilled by hand, with the user contacted, until admin tooling exists (M12). */
export async function requestPersonalData(db: Pick<PrismaClient, "auditLog">, actor: Actor, kind: "copy" | "delete") {
  await recordAudit(db, {
    actor: { type: "USER", id: actor.userId },
    action: kind === "copy" ? "user.data_copy_requested" : "user.deletion_requested",
    entity: { type: "User", id: actor.userId },
    requestId: actor.requestId,
  });
}
