import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { UserError } from "../../http/errors";
import { recordAudit } from "../audit/audit";

/**
 * Versioned consent (PLAN.md §4.2/§4.3). A consent counts only if it was granted for the
 * current policy version and not withdrawn. Changing CONSENT_POLICY_VERSION makes every
 * user re-confirm on their next sign-in.
 */
export const CONSENT_POLICY_VERSION = "2026-09-01";

export const CONSENT_PURPOSES = {
  ACCOUNT_AND_ORDERS: {
    required: true,
    title: "Your account and orders",
    summary:
      "We use your phone number, name and addresses to run your account, deliver orders and resolve disputes. Sellers and couriers see only what they need for your order.",
  },
  PHOTO_TRAINING_DATA: {
    required: false,
    title: "Improve part checks with your photos",
    summary: "Listing photos and inspection results help us improve automated part checks. Your name and phone number are never included.",
  },
  MARKETING_SMS: {
    required: false,
    title: "Offers by SMS",
    summary: "Occasional messages about parts for your bikes. You can turn this off any time.",
  },
} as const;

export type ConsentPurpose = keyof typeof CONSENT_PURPOSES;
export const CONSENT_PURPOSE_KEYS = Object.keys(CONSENT_PURPOSES) as ConsentPurpose[];
export const isConsentPurpose = (v: string): v is ConsentPurpose => v in CONSENT_PURPOSES;

type Db = Pick<PrismaClient, "$transaction" | "consentRecord">;
type Actor = { userId: string; requestId?: string };

export async function hasRequiredConsent(db: Pick<PrismaClient, "consentRecord">, userId: string): Promise<boolean> {
  const required = CONSENT_PURPOSE_KEYS.filter((p) => CONSENT_PURPOSES[p].required);
  const active = await db.consentRecord.findMany({
    where: { userId, purpose: { in: required }, version: CONSENT_POLICY_VERSION, withdrawnAt: null },
    select: { purpose: true },
  });
  return required.every((p) => active.some((a) => a.purpose === p));
}

export type ConsentStatus = { purpose: ConsentPurpose; granted: boolean; grantedAt: Date | null; required: boolean };

export async function listConsentStatus(db: Pick<PrismaClient, "consentRecord">, userId: string): Promise<ConsentStatus[]> {
  const active = await db.consentRecord.findMany({
    where: { userId, version: CONSENT_POLICY_VERSION, withdrawnAt: null },
    select: { purpose: true, grantedAt: true },
  });
  return CONSENT_PURPOSE_KEYS.map((purpose) => {
    const row = active.find((a) => a.purpose === purpose);
    return { purpose, granted: !!row, grantedAt: row?.grantedAt ?? null, required: CONSENT_PURPOSES[purpose].required };
  });
}

/**
 * Records consent for the current version. Any active consent for an older version of the
 * same purpose is closed, so each purpose has at most one active record.
 */
export async function grantConsents(
  db: Db,
  actor: Actor,
  purposes: ConsentPurpose[],
  tx?: Parameters<Parameters<Db["$transaction"]>[0]>[0],
): Promise<void> {
  const run = async (t: NonNullable<typeof tx>) => {
    const now = new Date();
    for (const purpose of new Set(purposes)) {
      const current = await t.consentRecord.findFirst({
        where: { userId: actor.userId, purpose, version: CONSENT_POLICY_VERSION, withdrawnAt: null },
      });
      if (current) continue;
      await t.consentRecord.updateMany({ where: { userId: actor.userId, purpose, withdrawnAt: null }, data: { withdrawnAt: now } });
      await t.consentRecord.create({ data: { userId: actor.userId, purpose, version: CONSENT_POLICY_VERSION, grantedAt: now } });
      await recordAudit(t, {
        actor: { type: "USER", id: actor.userId },
        action: "consent.granted",
        entity: { type: "User", id: actor.userId },
        after: { purpose, version: CONSENT_POLICY_VERSION },
        requestId: actor.requestId,
      });
    }
  };
  if (tx) await run(tx);
  else await db.$transaction(run);
}

/** Optional consents can be withdrawn any time. The required one can't: that means closing the account. */
export async function withdrawConsent(db: Db, actor: Actor, purpose: ConsentPurpose): Promise<void> {
  if (CONSENT_PURPOSES[purpose].required) {
    throw new UserError("This consent is needed to run your account. To stop it, ask us to delete your account below.");
  }
  await db.$transaction(async (tx) => {
    const { count } = await tx.consentRecord.updateMany({
      where: { userId: actor.userId, purpose, withdrawnAt: null },
      data: { withdrawnAt: new Date() },
    });
    if (count === 0) return;
    await recordAudit(tx, {
      actor: { type: "USER", id: actor.userId },
      action: "consent.withdrawn",
      entity: { type: "User", id: actor.userId },
      before: { purpose },
      requestId: actor.requestId,
    });
  });
}
