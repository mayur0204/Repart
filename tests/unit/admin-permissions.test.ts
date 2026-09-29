import { describe, expect, it, vi } from "vitest";

/**
 * Every admin action refuses non-admins before touching input or the database,
 * and the suggestion action needs a signed-in member.
 */
vi.mock("@/server/auth/current", () => ({ getCurrentUser: vi.fn(), clientIp: vi.fn(async () => "127.0.0.1") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { getCurrentUser } = await import("@/server/auth/current");
const adminActions = await import("../../app/admin/actions");
const partActions = await import("../../app/parts/actions");
const { WRAPPED } = await import("@/server/http/define-action");

const member = { id: "u1", phone: "+919876543210", name: "M", email: null, roles: ["MEMBER"] };
const mechanic = { ...member, id: "u2", roles: ["MEMBER", "MECHANIC"] };

describe("admin actions are admin-only", () => {
  const entries = Object.entries(adminActions) as Array<[string, (prev: null, fd: FormData) => Promise<{ ok: boolean; message?: string } | null>]>;

  it("covers every exported admin action", () => {
    expect(entries.length).toBeGreaterThanOrEqual(14);
    for (const [, action] of entries) expect((action as unknown as Record<symbol, unknown>)[WRAPPED]).toBe(true);
  });

  for (const [name, action] of entries) {
    it(`${name}: anonymous, member and mechanic are refused`, async () => {
      vi.mocked(getCurrentUser).mockResolvedValue(null);
      expect(await action(null, new FormData())).toMatchObject({ ok: false, message: expect.stringMatching(/Sign in/) });
      for (const user of [member, mechanic]) {
        vi.mocked(getCurrentUser).mockResolvedValue(user as never);
        expect(await action(null, new FormData())).toMatchObject({ ok: false, message: expect.stringMatching(/can't do that/) });
      }
    });
  }
});

describe("suggest an equivalent", () => {
  it("requires sign-in", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    expect(await partActions.suggestEquivalent(null, new FormData())).toMatchObject({ ok: false, message: expect.stringMatching(/Sign in/) });
  });
});
