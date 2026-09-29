import "server-only";
import { cookies } from "next/headers";
import { SESSION_TTL_MS } from "./session";

/** Cookie names are shared with proxy.ts, which only checks presence for coarse redirects. */
export const SESSION_COOKIE = "repart_session";
export const OTP_CHALLENGE_COOKIE = "repart_otp";

const base = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" };

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, { ...base, maxAge: SESSION_TTL_MS / 1000 });
}

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Pending OTP challenge id between the phone step and the code step. Short-lived. */
export async function setOtpChallengeCookie(challengeId: string) {
  (await cookies()).set(OTP_CHALLENGE_COOKIE, challengeId, { ...base, maxAge: 15 * 60 });
}

export async function readOtpChallengeId(): Promise<string | undefined> {
  return (await cookies()).get(OTP_CHALLENGE_COOKIE)?.value;
}

export async function clearOtpChallengeCookie() {
  (await cookies()).delete(OTP_CHALLENGE_COOKIE);
}
