import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { createMockOtpProvider, MOCK_OTP_CODE } from "../../src/server/adapters/otp/mock";
import { createSession, hashToken, resolveSession, revokeSession, SESSION_TTL_MS } from "../../src/server/auth/session";
import { FieldError, RateLimitedError, UserError } from "../../src/server/http/errors";
import { useRateLimitStore } from "../../src/server/http/rate-limit";
import { resendCode, startPhoneSignIn, verifyPhoneSignIn } from "../../src/server/services/auth/sign-in";
import { DEFAULT_SETTINGS } from "../../src/server/services/settings/schema";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const otp = createMockOtpProvider(() => {});
const limits = DEFAULT_SETTINGS.rateLimits;
let n = 0;
/** A fresh valid mobile per test so rate-limit keys never collide. */
const newPhone = () => `9${String(Date.now() % 1e5).padStart(5, "0")}${String(n++).padStart(4, "0")}`;
const ip = () => `10.0.0.${n++ % 250}`;

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
beforeEach(() => useRateLimitStore("memory"));
afterAll(async () => {
  useRateLimitStore("redis");
  await db.$disconnect();
});

async function signIn(phone = newPhone()) {
  const { challengeId } = await startPhoneSignIn(db, { phone, ip: ip() }, otp);
  return verifyPhoneSignIn(db, { challengeId, code: MOCK_OTP_CODE, userAgent: "vitest" }, otp);
}

describe("phone OTP sign-in", () => {
  it("creates a new user on first sign-in and reuses them afterwards", async () => {
    const phone = newPhone();
    const first = await signIn(phone);
    expect(first.isNewUser).toBe(true);
    const user = await db.user.findUniqueOrThrow({ where: { id: first.userId } });
    expect(user.phone).toBe(`+91${phone}`);
    expect(user.phoneVerifiedAt).not.toBeNull();

    const second = await signIn(phone);
    expect(second).toMatchObject({ isNewUser: false, userId: first.userId });
  });

  it("rejects invalid phone numbers with a field error", async () => {
    await expect(startPhoneSignIn(db, { phone: "12345", ip: ip() }, otp)).rejects.toBeInstanceOf(FieldError);
  });

  it("rejects a wrong code, counts the attempt, and still accepts the right one", async () => {
    const { challengeId } = await startPhoneSignIn(db, { phone: newPhone(), ip: ip() }, otp);
    await expect(verifyPhoneSignIn(db, { challengeId, code: "123456" }, otp)).rejects.toBeInstanceOf(FieldError);
    expect((await db.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } })).attempts).toBe(1);
    await expect(verifyPhoneSignIn(db, { challengeId, code: MOCK_OTP_CODE }, otp)).resolves.toMatchObject({ isNewUser: true });
  });

  it("locks a challenge after the configured number of attempts", async () => {
    const { challengeId } = await startPhoneSignIn(db, { phone: newPhone(), ip: ip() }, otp);
    for (let i = 0; i < limits.otpVerifyAttempts.points; i++) {
      await expect(verifyPhoneSignIn(db, { challengeId, code: "111111" }, otp)).rejects.toBeInstanceOf(FieldError);
    }
    await expect(verifyPhoneSignIn(db, { challengeId, code: MOCK_OTP_CODE }, otp)).rejects.toThrow(/Too many wrong codes/);
  });

  it("codes are single-use and expire", async () => {
    const { challengeId } = await startPhoneSignIn(db, { phone: newPhone(), ip: ip() }, otp);
    await verifyPhoneSignIn(db, { challengeId, code: MOCK_OTP_CODE }, otp);
    await expect(verifyPhoneSignIn(db, { challengeId, code: MOCK_OTP_CODE }, otp)).rejects.toBeInstanceOf(UserError);

    const second = await startPhoneSignIn(db, { phone: newPhone(), ip: ip() }, otp);
    const later = new Date(Date.now() + 10 * 60 * 1000);
    await expect(verifyPhoneSignIn(db, { challengeId: second.challengeId, code: MOCK_OTP_CODE }, otp, later)).rejects.toThrow(/expired/);
  });

  it("rate-limits code requests per phone using the settings limit", async () => {
    const phone = newPhone();
    for (let i = 0; i < limits.otpSendPerPhone.points; i++) await startPhoneSignIn(db, { phone, ip: ip() }, otp);
    await expect(startPhoneSignIn(db, { phone, ip: ip() }, otp)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("rate-limits code requests per IP across phones", async () => {
    const sameIp = "10.9.9.9";
    for (let i = 0; i < limits.otpSendPerIp.points; i++) await startPhoneSignIn(db, { phone: newPhone(), ip: sameIp }, otp);
    await expect(startPhoneSignIn(db, { phone: newPhone(), ip: sameIp }, otp)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("resend counts against the same send limit", async () => {
    const phone = newPhone();
    const { challengeId } = await startPhoneSignIn(db, { phone, ip: ip() }, otp);
    for (let i = 1; i < limits.otpSendPerPhone.points; i++) await resendCode(db, { challengeId, ip: ip() }, otp);
    await expect(resendCode(db, { challengeId, ip: ip() }, otp)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("refuses suspended accounts", async () => {
    const phone = newPhone();
    const first = await signIn(phone);
    await db.user.update({ where: { id: first.userId }, data: { status: "SUSPENDED" } });
    await expect(signIn(phone)).rejects.toThrow(/suspended/);
  });
});

describe("sessions", () => {
  it("stores only the SHA-256 hash of the token", async () => {
    const { token } = await signIn();
    expect(await db.session.count({ where: { tokenHash: token } })).toBe(0);
    expect(await db.session.count({ where: { tokenHash: hashToken(token) } })).toBe(1);
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 random bytes
  });

  it("resolves valid tokens and rejects unknown, expired and revoked ones", async () => {
    const { token, userId } = await signIn();
    expect((await resolveSession(db, token))?.user.id).toBe(userId);
    expect(await resolveSession(db, "not-a-token")).toBeNull();
    expect(await resolveSession(db, token, new Date(Date.now() + SESSION_TTL_MS + 1000))).toBeNull();
    await revokeSession(db, token);
    expect(await resolveSession(db, token)).toBeNull();
  });

  it("rolls the expiry forward on use after a day", async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: (await signIn()).userId } });
    const start = new Date("2026-01-01T00:00:00Z");
    const { token } = await createSession(db, user.id, null, start);
    const twoDaysLater = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000);
    await resolveSession(db, token, twoDaysLater);
    const row = await db.session.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
    expect(row.expiresAt.getTime()).toBe(twoDaysLater.getTime() + SESSION_TTL_MS);
  });

  it("stops resolving when the user is suspended", async () => {
    const { token, userId } = await signIn();
    await db.user.update({ where: { id: userId }, data: { status: "SUSPENDED" } });
    expect(await resolveSession(db, token)).toBeNull();
  });
});
