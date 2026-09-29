import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { Role } from "@/generated/prisma/client";
import { withNext } from "@/lib/return-to";
import { db } from "../db";
import { hasRequiredConsent } from "../services/consent/consent";
import { clearSessionCookie, readSessionToken } from "./cookies";
import { resolveSession, revokeSession, type SessionUser } from "./session";

/** The signed-in user for this request, or null. Cached per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = await readSessionToken();
  if (!token) return null;
  return (await resolveSession(db, token))?.user ?? null;
});

/** Signed in, named and consented at the current policy version. */
export async function needsOnboarding(user: Pick<SessionUser, "id" | "name">): Promise<boolean> {
  return !user.name || !(await hasRequiredConsent(db, user.id));
}

export async function needsOnboardingById(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  return !user?.name || !(await hasRequiredConsent(db, userId));
}

/** Revokes the session in the cookie (if any) and clears the cookie. */
export async function endCurrentSession(): Promise<void> {
  const token = await readSessionToken();
  if (token) await revokeSession(db, token);
  await clearSessionCookie();
}

/**
 * For member pages: redirects to sign-in (returning here afterwards) when signed out,
 * and to about-you when the user hasn't finished onboarding.
 */
export async function requireMemberPage(path: string, opts: { roles?: Role[] } = {}): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(withNext("/sign-in", path));
  if (await needsOnboarding(user)) redirect(withNext("/sign-in/about-you", path));
  if (opts.roles && !opts.roles.some((r) => user.roles.includes(r))) redirect("/");
  return user;
}

/** For admin pages: returns the admin, or null when the signed-in user isn't an admin (render PermissionDenied). */
export async function adminPage(path: string): Promise<SessionUser | null> {
  const user = await requireMemberPage(path);
  return user.roles.includes("ADMIN") ? user : null;
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

export async function userAgent(): Promise<string | null> {
  return (await headers()).get("user-agent");
}
