import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { normalizeIndianPhone } from "@/lib/phone";
import { adapters } from "../../adapters";
import type { OtpProvider } from "../../adapters/otp/types";
import { createSession } from "../../auth/session";
import { FieldError, UserError } from "../../http/errors";
import { consumeRateLimit, rateLimitsFromSettings } from "../../http/rate-limit";
import { logger } from "../../logger";

/**
 * Phone OTP sign-in (REPART_BRIEF.md §9, PLAN.md §1.2 "Auth"). Our own flow; no Supabase Auth.
 * The OTP provider sends and checks codes; this service owns challenges, limits, users and sessions.
 */
type Db = Pick<PrismaClient, "$transaction" | "otpChallenge" | "user" | "session" | "settingsVersion">;

const allowSamplePhones = () => process.env.NODE_ENV !== "production";

export function parsePhone(input: string): string {
  const phone = normalizeIndianPhone(input, { allowSample: allowSamplePhones() });
  if (!phone) throw new FieldError({ phone: "Enter a 10-digit Indian mobile number, for example 98765 43210." });
  return phone;
}

/** Step 1: send a code. Limited per phone and per IP (limits come from the active settings). */
export async function startPhoneSignIn(
  db: Db,
  input: { phone: string; ip: string },
  otp: OtpProvider = adapters().otp,
): Promise<{ challengeId: string; phone: string }> {
  const phone = parsePhone(input.phone);
  await consumeRateLimit(db, "otpSendPerIp", input.ip);
  await consumeRateLimit(db, "otpSendPerPhone", phone);
  const sent = await otp.send(phone);
  const challenge = await db.otpChallenge.create({
    data: { phone, expiresAt: new Date(Date.now() + sent.expiresInSeconds * 1000) },
    select: { id: true },
  });
  return { challengeId: challenge.id, phone };
}

/** The pending (unverified, unexpired) challenge for the code page, or null. */
export async function getPendingChallenge(db: Pick<PrismaClient, "otpChallenge">, challengeId: string) {
  const challenge = await db.otpChallenge.findUnique({ where: { id: challengeId }, select: { phone: true, verifiedAt: true, expiresAt: true } });
  if (!challenge || challenge.verifiedAt || challenge.expiresAt <= new Date()) return null;
  return { phone: challenge.phone };
}

/** Resend for an existing, unexpired challenge: counts against the same send limits and issues a fresh challenge. */
export async function resendCode(db: Db, input: { challengeId: string; ip: string }, otp: OtpProvider = adapters().otp) {
  const challenge = await db.otpChallenge.findUnique({ where: { id: input.challengeId } });
  if (!challenge || challenge.verifiedAt) throw new UserError("Start again by entering your phone number.");
  return startPhoneSignIn(db, { phone: challenge.phone, ip: input.ip }, otp);
}

export type SignInResult = { token: string; expiresAt: Date; userId: string; isNewUser: boolean };

/**
 * Step 2: check the code. Each challenge allows `otpVerifyAttempts.points` tries, and the same
 * limit applies per phone across challenges, so requesting new codes doesn't reset guessing.
 */
export async function verifyPhoneSignIn(
  db: Db,
  input: { challengeId: string; code: string; userAgent?: string | null },
  otp: OtpProvider = adapters().otp,
  now = new Date(),
): Promise<SignInResult> {
  if (!/^\d{6}$/.test(input.code)) throw new FieldError({ code: "Enter the 6-digit code from the SMS." });

  const challenge = await db.otpChallenge.findUnique({ where: { id: input.challengeId } });
  if (!challenge || challenge.verifiedAt || challenge.expiresAt <= now) {
    throw new UserError("This code has expired. Request a new code.");
  }
  const maxAttempts = (await rateLimitsFromSettings(db)).otpVerifyAttempts.points;
  const { count } = await db.otpChallenge.updateMany({
    where: { id: challenge.id, verifiedAt: null, attempts: { lt: maxAttempts } },
    data: { attempts: { increment: 1 } },
  });
  if (count === 0) throw new UserError("Too many wrong codes. Request a new code.");
  await consumeRateLimit(db, "otpVerifyAttempts", challenge.phone);

  const { valid } = await otp.verify(challenge.phone, input.code);
  if (!valid) throw new FieldError({ code: "That code is wrong. Check the SMS and try again." });

  return db.$transaction(async (tx) => {
    // Single use: only one request can flip verifiedAt.
    const claimed = await tx.otpChallenge.updateMany({ where: { id: challenge.id, verifiedAt: null }, data: { verifiedAt: now } });
    if (claimed.count === 0) throw new UserError("This code has already been used. Request a new code.");

    let user = await tx.user.findUnique({ where: { phone: challenge.phone }, select: { id: true, status: true } });
    const isNewUser = !user;
    user ??= await tx.user.create({ data: { phone: challenge.phone, phoneVerifiedAt: now }, select: { id: true, status: true } });
    if (user.status !== "ACTIVE") throw new UserError("This account is suspended. Contact support to find out why.");
    if (!isNewUser) await tx.user.update({ where: { id: user.id }, data: { phoneVerifiedAt: now } });

    const session = await createSession(tx, user.id, input.userAgent, now);
    logger.info({ userId: user.id, isNewUser }, "signed in");
    return { ...session, userId: user.id, isNewUser };
  });
}
