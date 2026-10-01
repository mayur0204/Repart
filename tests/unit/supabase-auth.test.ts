import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Supabase Auth integration: Supabase says who the user is; the RePart User row (roles, status) decides access.
 * Supabase and the database are faked, so this runs without network or Postgres.
 */
type FakeUser = { id: string; phone: string; name: string | null; email: string | null; roles: string[]; status: string; supabaseAuthUserId: string | null; isSample?: boolean };

const state = vi.hoisted(() => ({ users: [] as FakeUser[] }));
const fakeDb = vi.hoisted(() => ({
  user: {
    findUnique: async ({ where }: { where: Record<string, unknown> }) =>
      state.users.find((u) => Object.entries(where).every(([k, v]) => (u as Record<string, unknown>)[k] === v)) ?? null,
    findFirst: async ({ where }: { where: { email: { equals: string }; isSample: boolean } }) =>
      state.users.find((u) => u.email?.toLowerCase() === where.email.equals && !!u.isSample === where.isSample) ?? null,
    create: async ({ data }: { data: Partial<FakeUser> }) => {
      if (state.users.some((u) => u.phone === data.phone || (data.supabaseAuthUserId && u.supabaseAuthUserId === data.supabaseAuthUserId))) {
        const { Prisma } = await import("@/generated/prisma/client"); // what Postgres' unique indexes raise
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
      }
      const user = { id: `user-${state.users.length + 1}`, name: null, email: null, roles: ["MEMBER"], status: "ACTIVE", supabaseAuthUserId: null, phone: "", ...data };
      state.users.push(user);
      return user;
    },
  },
  settingsVersion: {},
}));

vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<object>()), cache: <T>(fn: T) => fn }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  unstable_rethrow: () => {},
}));
vi.mock("@/server/db", () => ({ db: fakeDb }));
vi.mock("@/server/auth/supabase", () => ({ currentAuthUserId: vi.fn(async () => null), createSupabaseServerClient: vi.fn(async () => null) }));
vi.mock("@/server/auth/cookies", () => ({ readSessionToken: vi.fn(async () => undefined), clearSessionCookie: vi.fn(async () => {}) }));
vi.mock("@/server/services/consent/consent", () => ({ hasRequiredConsent: async () => true }));
vi.mock("@/server/http/rate-limit", () => ({ assertWithinRateLimit: vi.fn(async () => {}), consumeRateLimit: vi.fn(async () => {}) }));

const { finishAccount, signInWithEmail, signUpWithEmail, SUSPENDED_MESSAGE } = await import("@/server/services/auth/email-auth");
const { adminPage, endCurrentSession, getCurrentUser, requireMemberPage } = await import("@/server/auth/current");
const { defineRoute } = await import("@/server/http/define-route");
const supabaseModule = await import("@/server/auth/supabase");
const cookiesModule = await import("@/server/auth/cookies");

const seedUsers = (): FakeUser[] => [
  { id: "admin", phone: "+919800000001", name: "Admin", email: null, roles: ["MEMBER", "ADMIN"], status: "ACTIVE", supabaseAuthUserId: "auth-admin" },
  { id: "mechanic", phone: "+919800000002", name: "Mech", email: null, roles: ["MEMBER", "MECHANIC"], status: "ACTIVE", supabaseAuthUserId: "auth-mechanic" },
  { id: "member", phone: "+919800000003", name: "Mem", email: null, roles: ["MEMBER"], status: "ACTIVE", supabaseAuthUserId: "auth-member" },
  { id: "suspended", phone: "+919800000004", name: "Sus", email: null, roles: ["MEMBER", "ADMIN"], status: "SUSPENDED", supabaseAuthUserId: "auth-suspended" },
];

/** A stand-in for supabase.auth with an in-memory account list. */
function fakeAuth(opts: { confirmEmail?: boolean } = {}) {
  const accounts = new Map<string, { id: string; password: string; phone?: string }>([
    ["admin@example.test", { id: "auth-admin", password: "admin-password" }],
    ["suspended@example.test", { id: "auth-suspended", password: "suspended-password" }],
    ["orphan@example.test", { id: "auth-orphan", password: "orphan-password" }],
  ]);
  return {
    signUp: vi.fn(async ({ email, password, options }: { email: string; password: string; options?: { data?: { phone?: string } } }) => {
      if (accounts.has(email)) {
        return opts.confirmEmail
          ? { data: { user: { id: "obfuscated", identities: [] }, session: null }, error: null }
          : { data: { user: null, session: null }, error: { code: "user_already_exists", status: 422 } };
      }
      const id = `auth-new-${accounts.size}`;
      accounts.set(email, { id, password, phone: options?.data?.phone });
      return { data: { user: { id, identities: [{ id }] }, session: opts.confirmEmail ? null : { access_token: "t" } }, error: null };
    }),
    signInWithPassword: vi.fn(async ({ email, password }: { email: string; password: string }) => {
      const a = accounts.get(email);
      return a && a.password === password
        ? { data: { user: { id: a.id, user_metadata: a.phone ? { phone: a.phone } : {} }, session: { access_token: "t" } }, error: null }
        : { data: { user: null, session: null }, error: { code: "invalid_credentials", status: 400 } };
    }),
    signOut: vi.fn(async () => ({ error: null })),
  };
}

const ctx = { ip: "127.0.0.1", emailRedirectTo: "http://localhost:3000/auth/callback" };
const signedInAs = (authUserId: string | null) => vi.mocked(supabaseModule.currentAuthUserId).mockResolvedValue(authUserId);

beforeEach(() => {
  state.users = seedUsers();
  signedInAs(null);
});

describe("sign up", () => {
  it("creates a MEMBER RePart user linked to the Supabase user, never stores the password, never grants ADMIN by email", async () => {
    const auth = fakeAuth();
    const result = await signUpWithEmail(fakeDb as never, auth as never, { email: " Admin@RePart.test ", password: "long-enough", phone: "98765 43210" }, ctx);
    expect(result.status).toBe("signed-in");
    const created = state.users.at(-1)!;
    expect(created).toMatchObject({ email: "admin@repart.test", phone: "+919876543210", roles: ["MEMBER"], supabaseAuthUserId: expect.stringMatching(/^auth-new-/) });
    expect(JSON.stringify(created)).not.toContain("long-enough");
  });

  it("refuses a mobile number that already belongs to an account, before calling Supabase", async () => {
    const auth = fakeAuth();
    await expect(signUpWithEmail(fakeDb as never, auth as never, { email: "new@example.test", password: "long-enough", phone: "98000 00001" }, ctx)).rejects.toThrow(/already belongs/);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it("asks for email confirmation when Supabase requires it, and doesn't create a user for a repeat sign-up", async () => {
    const auth = fakeAuth({ confirmEmail: true });
    expect(await signUpWithEmail(fakeDb as never, auth as never, { email: "fresh@example.test", password: "long-enough", phone: "9876500001" }, ctx)).toEqual({ status: "check-email" });
    const count = state.users.length;
    expect(await signUpWithEmail(fakeDb as never, auth as never, { email: "admin@example.test", password: "long-enough", phone: "9876500002" }, ctx)).toEqual({ status: "check-email" });
    expect(state.users).toHaveLength(count);
  });

  it("rejects short passwords and bad emails", async () => {
    await expect(signUpWithEmail(fakeDb as never, fakeAuth() as never, { email: "x@example.test", password: "short", phone: "9876543210" }, ctx)).rejects.toThrow();
    await expect(signUpWithEmail(fakeDb as never, fakeAuth() as never, { email: "not-an-email", password: "long-enough", phone: "9876543210" }, ctx)).rejects.toThrow();
  });
});

describe("sign up recovery and idempotency", () => {
  it("re-signing up with the same email and password finishes a Supabase login that has no RePart user", async () => {
    const auth = fakeAuth();
    const result = await signUpWithEmail(fakeDb as never, auth as never, { email: "orphan@example.test", password: "orphan-password", phone: "9876500003" }, ctx);
    expect(result).toEqual({ status: "signed-in", userId: expect.any(String) });
    expect(state.users.at(-1)).toMatchObject({ supabaseAuthUserId: "auth-orphan", email: "orphan@example.test", phone: "+919876500003", roles: ["MEMBER"], status: "ACTIVE" });
  });

  it("the same email with a wrong password still says the account exists, and creates nothing", async () => {
    const count = state.users.length;
    await expect(signUpWithEmail(fakeDb as never, fakeAuth() as never, { email: "orphan@example.test", password: "wrong-password", phone: "9876500003" }, ctx)).rejects.toThrow(/already exists/);
    expect(state.users).toHaveLength(count);
  });

  it("submitting the same sign-up twice never creates a second RePart user", async () => {
    const auth = fakeAuth();
    const input = { email: "twice@example.test", password: "long-enough", phone: "9876500004" };
    await signUpWithEmail(fakeDb as never, auth as never, input, ctx);
    await expect(signUpWithEmail(fakeDb as never, auth as never, input, ctx)).rejects.toThrow(/already belongs/);
    expect(state.users.filter((u) => u.email === "twice@example.test")).toHaveLength(1);
  });

  it("refuses an email that already belongs to a RePart user, before calling Supabase", async () => {
    state.users.push({ id: "legacy", phone: "+919800000009", name: "L", email: "Legacy@Example.test", roles: ["MEMBER"], status: "ACTIVE", supabaseAuthUserId: null });
    const auth = fakeAuth();
    await expect(signUpWithEmail(fakeDb as never, auth as never, { email: "legacy@example.test", password: "long-enough", phone: "9876500005" }, ctx)).rejects.toThrow(/already exists/);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it("when the RePart user can't be created, signs the Supabase session out and says so", async () => {
    const auth = fakeAuth();
    const create = vi.spyOn(fakeDb.user, "create").mockRejectedValueOnce(new Error("db down"));
    await expect(signUpWithEmail(fakeDb as never, auth as never, { email: "flaky@example.test", password: "long-enough", phone: "9876500006" }, ctx)).rejects.toThrow(/couldn't finish/);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    create.mockRestore();
    // Signing in afterwards finishes the account from the phone stored at sign-up.
    expect(await signInWithEmail(fakeDb as never, auth as never, { email: "flaky@example.test", password: "long-enough" })).toEqual({ status: "signed-in", userId: expect.any(String) });
    expect(state.users.at(-1)).toMatchObject({ email: "flaky@example.test", phone: "+919876500006", roles: ["MEMBER"] });
  });
});

describe("sign in", () => {
  it("returns the linked RePart user for the right password", async () => {
    expect(await signInWithEmail(fakeDb as never, fakeAuth() as never, { email: "admin@example.test", password: "admin-password" })).toEqual({ status: "signed-in", userId: "admin" });
  });

  it("rejects a wrong password without saying which part was wrong", async () => {
    await expect(signInWithEmail(fakeDb as never, fakeAuth() as never, { email: "admin@example.test", password: "nope" })).rejects.toThrow(/don't match/);
  });

  it("signs a suspended user straight back out", async () => {
    const auth = fakeAuth();
    await expect(signInWithEmail(fakeDb as never, auth as never, { email: "suspended@example.test", password: "suspended-password" })).rejects.toThrow(SUSPENDED_MESSAGE);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  // Regression: a Supabase login created while the RePart insert failed (stale Prisma client), before sign-up stored the
  // phone. A SAMPLE user shares its email. Sign-in must not dead-end, guess a phone, or link the sample user.
  it("an orphaned login with no stored phone is asked for its number once, then signs in normally", async () => {
    state.users.push({ id: "sample-user-seller", phone: "+915555500003", name: "Sample Seller", email: "orphan@example.test", roles: ["MEMBER"], status: "ACTIVE", supabaseAuthUserId: null, isSample: true });
    const auth = fakeAuth();
    const creds = { email: "orphan@example.test", password: "orphan-password" };
    expect(await signInWithEmail(fakeDb as never, auth as never, creds)).toEqual({ status: "needs-phone" });
    expect(auth.signOut).not.toHaveBeenCalled(); // the verified Supabase session carries them to the phone step
    expect(state.users.some((u) => u.supabaseAuthUserId === "auth-orphan")).toBe(false);
    expect(await getCurrentUser()).toBeNull(); // no RePart user yet: treated as signed out everywhere else

    const verified = { id: "auth-orphan", email: "Orphan@Example.test" };
    await expect(finishAccount(fakeDb as never, verified, { phone: "98000 00001" })).rejects.toThrow(/already belongs/); // someone else's number
    const { userId } = await finishAccount(fakeDb as never, verified, { phone: "98765 00007" });
    expect(await finishAccount(fakeDb as never, verified, { phone: "98765 00007" })).toEqual({ userId }); // retry: same user
    expect(state.users.filter((u) => u.supabaseAuthUserId === "auth-orphan")).toEqual([
      expect.objectContaining({ id: userId, email: "orphan@example.test", phone: "+919876500007", roles: ["MEMBER"], status: "ACTIVE" }),
    ]);
    expect(state.users.find((u) => u.id === "sample-user-seller")?.supabaseAuthUserId).toBeNull();

    expect(await signInWithEmail(fakeDb as never, auth as never, creds)).toEqual({ status: "signed-in", userId });
    signedInAs("auth-orphan");
    expect((await getCurrentUser())?.id).toBe(userId);
  });
});

describe("session → RePart user mapping", () => {
  it("a request with a verified Supabase session resolves to the RePart user and its RePart roles, on every request", async () => {
    signedInAs("auth-admin");
    expect(await getCurrentUser()).toEqual({ id: "admin", phone: "+919800000001", name: "Admin", email: null, roles: ["MEMBER", "ADMIN"] });
    expect((await getCurrentUser())?.id).toBe("admin"); // e.g. after a page refresh: same cookie, same user
  });

  it("treats suspended and unlinked Supabase users as signed out", async () => {
    signedInAs("auth-suspended");
    expect(await getCurrentUser()).toBeNull();
    signedInAs("auth-orphan");
    expect(await getCurrentUser()).toBeNull();
  });

  it("sign out clears the Supabase session and the RePart session cookie", async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    vi.mocked(supabaseModule.createSupabaseServerClient).mockResolvedValueOnce({ auth: { signOut } } as never);
    await endCurrentSession();
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(cookiesModule.clearSessionCookie).toHaveBeenCalled();
  });
});

describe("protected pages and RBAC with Supabase identities", () => {
  it("protected pages redirect to sign-in when signed out (including after sign out)", async () => {
    await expect(requireMemberPage("/account")).rejects.toThrow("REDIRECT /sign-in?next=%2Faccount");
  });

  it("admin pages: admin gets in, member and mechanic get PermissionDenied", async () => {
    signedInAs("auth-admin");
    expect((await adminPage("/admin"))?.id).toBe("admin");
    for (const who of ["auth-member", "auth-mechanic"]) {
      signedInAs(who);
      expect(await adminPage("/admin")).toBeNull();
    }
  });

  const status = async (access: Parameters<typeof defineRoute>[0]["access"], authUserId: string | null) => {
    signedInAs(authUserId);
    const route = defineRoute({ access }, async () => new Response("ok"));
    return (await route(new Request("http://localhost/api/x"))).status;
  };

  it.each([
    ["member route", "member", { "auth-member": 200, "auth-mechanic": 200, "auth-admin": 200 }],
    ["mechanic route", ["MECHANIC"], { "auth-member": 403, "auth-mechanic": 200, "auth-admin": 403 }],
    ["admin route", ["ADMIN"], { "auth-member": 403, "auth-mechanic": 403, "auth-admin": 200 }],
  ] as const)("%s allows exactly the right RePart roles", async (_name, access, expected) => {
    for (const [who, code] of Object.entries(expected)) expect(await status(access as never, who)).toBe(code);
  });

  it("signed-out and suspended users get 401 even on routes their roles would allow", async () => {
    expect(await status(["ADMIN"], null)).toBe(401);
    expect(await status(["ADMIN"], "auth-suspended")).toBe(401);
  });
});
