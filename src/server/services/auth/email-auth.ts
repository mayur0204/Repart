import "server-only";
import { z } from "zod";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { SupabaseAuth } from "../../auth/supabase";
import { FieldError, UserError } from "../../http/errors";
import { assertWithinRateLimit, consumeRateLimit } from "../../http/rate-limit";
import { logger } from "../../logger";
import { parsePhone } from "./sign-in";

/**
 * Email + password sign-in through Supabase Auth. Supabase stores passwords and issues the session cookies;
 * this service links each Supabase user to exactly one RePart User by `supabaseAuthUserId`.
 * Never links by email or phone (neither is verified, so that would let anyone claim an existing account), and never
 * grants roles: new users get the schema defaults [MEMBER], ACTIVE, isSample false.
 */
type Db = Pick<PrismaClient, "user" | "settingsVersion">;
type Auth = Pick<SupabaseAuth, "signUp" | "signInWithPassword" | "signOut">;
type AuthUser = { id: string; user_metadata?: Record<string, unknown> };

export const SUSPENDED_MESSAGE = "This account is suspended. Contact support to find out why.";
const PHONE_TAKEN = "This number already belongs to a RePart account. Sign in with that account instead.";
const ACCOUNT_EXISTS = new Set(["user_already_exists", "email_exists"]);

const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address."));
const signUpInput = z.object({
  email,
  password: z.string().min(8, "Use at least 8 characters.").max(72, "Use 72 characters or fewer."),
  phone: z.string().default(""),
});
const signInInput = z.object({ email, password: z.string().min(1, "Enter your password.") });

export type SignUpResult = { status: "signed-in"; userId: string } | { status: "check-email" };
/** "needs-phone": the password was right but the login has no RePart User and no phone to create one with. */
export type SignInResult = { status: "signed-in"; userId: string } | { status: "needs-phone" };

/**
 * The RePart User for a Supabase user, created on first call. Idempotent: keyed on the unique supabaseAuthUserId,
 * so retries, refreshes and double submits all land on the same row. `phone` is null when the caller doesn't have one.
 */
async function ensureRepartUser(db: Db, authUserId: string, email: string, phone: string | null): Promise<{ id: string; status: string } | null> {
  const select = { id: true, status: true } as const;
  const linked = await db.user.findUnique({ where: { supabaseAuthUserId: authUserId }, select });
  if (linked) return linked;
  if (!phone) return null;
  try {
    const user = await db.user.create({ data: { supabaseAuthUserId: authUserId, email, phone }, select });
    logger.info({ userId: user.id }, "account created");
    return user;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    // A concurrent request created it first, or someone took the number in between.
    const raced = await db.user.findUnique({ where: { supabaseAuthUserId: authUserId }, select });
    if (raced) return raced;
    throw new FieldError({ phone: PHONE_TAKEN });
  }
}

/** The phone sign-up stored on the Supabase user, so sign-in can finish an account whose setup failed. */
function signUpPhone(user: AuthUser): string | null {
  const phone = user.user_metadata?.phone;
  return typeof phone === "string" ? phone : null;
}

export async function signUpWithEmail(db: Db, auth: Auth, input: unknown, ctx: { ip: string; emailRedirectTo: string }): Promise<SignUpResult> {
  const { email, password, phone: rawPhone } = signUpInput.parse(input);
  // RePart needs a mobile number for orders and couriers (User.phone is required). Not verified by SMS.
  const phone = parsePhone(rawPhone);
  await consumeRateLimit(db, "otpSendPerIp", `signup:${ctx.ip}`);
  if (await db.user.findUnique({ where: { phone }, select: { id: true } })) throw new FieldError({ phone: PHONE_TAKEN });
  if (await db.user.findFirst({ where: { email: { equals: email, mode: "insensitive" }, isSample: false }, select: { id: true } })) {
    throw new UserError("An account with this email already exists. Sign in instead.");
  }

  const signUp = await auth.signUp({ email, password, options: { emailRedirectTo: ctx.emailRedirectTo, data: { phone } } });
  const { error } = signUp;
  let { user: authUser, session } = signUp.data;
  if (error && !ACCOUNT_EXISTS.has(error.code ?? "")) {
    if (error.code === "weak_password") throw new FieldError({ password: "Choose a stronger password." });
    logger.warn({ code: error.code, status: error.status }, "supabase sign-up failed");
    throw new UserError("We couldn't create your account. Try again in a moment.");
  }

  // With email confirmation on, Supabase answers a repeat sign-up with a placeholder user that has no identities.
  if (error || !authUser || authUser.identities?.length === 0) {
    // The email already has a Supabase login: a retry, or an earlier sign-up whose RePart account wasn't created.
    // The right password proves it's theirs, so finish the account instead of dead-ending them.
    const limitKey = `email:${email}`;
    await assertWithinRateLimit(db, "otpVerifyAttempts", limitKey);
    const login = await auth.signInWithPassword({ email, password });
    if (login.error?.code === "email_not_confirmed") return { status: "check-email" };
    if (login.error || !login.data.user) {
      await consumeRateLimit(db, "otpVerifyAttempts", limitKey);
      if (error) throw new UserError("An account with this email already exists. Sign in instead.");
      return { status: "check-email" }; // don't reveal whether the email is registered
    }
    ({ user: authUser, session } = login.data);
  }

  let user;
  try {
    user = (await ensureRepartUser(db, authUser.id, email, phone))!;
  } catch (err) {
    // Don't leave a Supabase session without a RePart account behind it.
    if (session) await auth.signOut({ scope: "local" });
    if (err instanceof UserError || err instanceof FieldError) throw err;
    logger.error({ err, authUserId: authUser.id }, "RePart user creation failed after supabase sign-up");
    throw new UserError("Your login was created but we couldn't finish setting up your account. Try again: use the same email and password.");
  }
  if (user.status !== "ACTIVE") {
    if (session) await auth.signOut({ scope: "local" });
    throw new UserError(SUSPENDED_MESSAGE);
  }
  return session ? { status: "signed-in", userId: user.id } : { status: "check-email" };
}

export async function signInWithEmail(db: Db, auth: Auth, input: unknown): Promise<SignInResult> {
  const { email, password } = signInInput.parse(input);
  // Only failed attempts count, so signing in and out repeatedly (a demo) never locks an account.
  const limitKey = `email:${email}`;
  await assertWithinRateLimit(db, "otpVerifyAttempts", limitKey);
  const { data, error } = await auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    if (error?.code === "email_not_confirmed") throw new UserError("Confirm your email first: open the link we sent you, then sign in.");
    await consumeRateLimit(db, "otpVerifyAttempts", limitKey);
    throw new UserError("That email and password don't match. Check them and try again.");
  }

  let user;
  try {
    // Normally already linked at sign-up; this finishes an account whose setup failed after Supabase created the login.
    const phone = signUpPhone(data.user);
    user = await ensureRepartUser(db, data.user.id, email, phone ? parsePhone(phone) : null);
  } catch (err) {
    await auth.signOut({ scope: "local" });
    throw err;
  }
  // Signed up before sign-up stored the phone and its RePart User was never created: keep the verified Supabase
  // session and ask for the number once (finishAccount). Until then getCurrentUser treats them as signed out.
  if (!user) return { status: "needs-phone" };
  if (user.status !== "ACTIVE") {
    await auth.signOut({ scope: "local" });
    throw new UserError(SUSPENDED_MESSAGE);
  }
  logger.info({ userId: user.id }, "signed in");
  return { status: "signed-in", userId: user.id };
}

/**
 * Creates the RePart User for a verified Supabase session that has none (see "needs-phone"). Idempotent.
 * `authUser` must come from verified JWT claims, never from the form.
 */
export async function finishAccount(db: Db, authUser: { id: string; email?: string }, input: unknown): Promise<{ userId: string }> {
  const { phone } = z.object({ phone: z.string().default("") }).parse(input);
  if (!authUser.email) throw new UserError("This login has no email address. Contact support.");
  const user = (await ensureRepartUser(db, authUser.id, authUser.email.toLowerCase(), parsePhone(phone)))!;
  if (user.status !== "ACTIVE") throw new UserError(SUSPENDED_MESSAGE);
  return { userId: user.id };
}
