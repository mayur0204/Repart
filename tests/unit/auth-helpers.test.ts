import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maskPhone, normalizeIndianPhone } from "@/lib/phone";
import { safeNext, withNext } from "@/lib/return-to";
import { RateLimitedError } from "@/server/http/errors";
import { consumeWithLimit, useRateLimitStore } from "@/server/http/rate-limit";

describe("normalizeIndianPhone", () => {
  it("accepts common formats of real mobile numbers", () => {
    for (const input of ["9876543210", "98765 43210", "+91 98765-43210", "919876543210", "09876543210"]) {
      expect(normalizeIndianPhone(input)).toBe("+919876543210");
    }
  });

  it("rejects landlines, short numbers and non-Indian numbers", () => {
    for (const input of ["", "12345", "5876543210", "+14155552671", "98765432101"]) {
      expect(normalizeIndianPhone(input)).toBeNull();
    }
  });

  it("accepts SAMPLE numbers only when allowed", () => {
    expect(normalizeIndianPhone("+915555500001")).toBeNull();
    expect(normalizeIndianPhone("+915555500001", { allowSample: true })).toBe("+915555500001");
  });

  it("masks all but the first and last two digits", () => {
    expect(maskPhone("+919876543210")).toBe("+91 98••••••10");
  });
});

describe("safeNext (return-to)", () => {
  it("keeps same-site paths with their query", () => {
    expect(safeNext("/garage")).toBe("/garage");
    expect(safeNext("/listings/abc?tab=fit")).toBe("/listings/abc?tab=fit");
    expect(safeNext(encodeURIComponent("/account/addresses"))).toBe("/account/addresses");
  });

  it("blocks open redirects and falls back", () => {
    for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "evil.com", "%2F%2Fevil.com", "/%0d%0aSet-Cookie:x", "%E0%A4%A"]) {
      expect(safeNext(bad)).toBe("/");
    }
    expect(safeNext(undefined, "/garage")).toBe("/garage");
  });

  it("never returns into the sign-in flow or API", () => {
    expect(safeNext("/sign-in/verify")).toBe("/");
    expect(safeNext("/sign-in?next=/x")).toBe("/");
    expect(safeNext("/api/health")).toBe("/");
    expect(safeNext("/sign-inside")).toBe("/sign-inside");
  });

  it("withNext only adds a meaningful next", () => {
    expect(withNext("/sign-in", "/garage")).toBe("/sign-in?next=%2Fgarage");
    expect(withNext("/sign-in", "/")).toBe("/sign-in");
    expect(withNext("/sign-in", "https://evil.com")).toBe("/sign-in");
  });
});

describe("rate limiting", () => {
  beforeEach(() => useRateLimitStore("memory"));
  afterEach(() => useRateLimitStore("redis"));

  it("allows the configured points per window, then reports the wait", async () => {
    const limit = { points: 3, windowSeconds: 600 };
    for (let i = 0; i < 3; i++) await consumeWithLimit("otpSendPerPhone", "+919876543210", limit);
    const err = await consumeWithLimit("otpSendPerPhone", "+919876543210", limit).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSeconds).toBeGreaterThan(590);
    expect(err.message).toMatch(/Try again in 10 minutes/);
  });

  it("counts keys and limit names independently", async () => {
    const limit = { points: 1, windowSeconds: 60 };
    await consumeWithLimit("otpSendPerPhone", "a", limit);
    await consumeWithLimit("otpSendPerPhone", "b", limit);
    await consumeWithLimit("otpSendPerIp", "a", limit);
    await expect(consumeWithLimit("otpSendPerPhone", "a", limit)).rejects.toBeInstanceOf(RateLimitedError);
  });
});

vi.mock("@/server/auth/current", () => ({ getCurrentUser: vi.fn(), clientIp: vi.fn(async () => "127.0.0.1") }));

describe("defineAction RBAC matrix", async () => {
  const { getCurrentUser } = await import("@/server/auth/current");
  const { defineAction, formDataToObject } = await import("@/server/http/define-action");
  const { z } = await import("zod");

  const users = {
    anonymous: null,
    member: { id: "u1", phone: "+919876543210", name: "M", email: null, roles: ["MEMBER"] },
    mechanic: { id: "u2", phone: "+919876543211", name: "Mc", email: null, roles: ["MEMBER", "MECHANIC"] },
    admin: { id: "u3", phone: "+919876543212", name: "A", email: null, roles: ["MEMBER", "ADMIN"] },
  } as const;
  const accesses = { public: "public", member: "member", mechanic: ["MECHANIC"], admin: ["ADMIN"] } as const;
  const expected: Record<keyof typeof accesses, Record<keyof typeof users, boolean>> = {
    public: { anonymous: true, member: true, mechanic: true, admin: true },
    member: { anonymous: false, member: true, mechanic: true, admin: true },
    mechanic: { anonymous: false, member: false, mechanic: true, admin: false },
    admin: { anonymous: false, member: false, mechanic: false, admin: true },
  };

  for (const [accessName, access] of Object.entries(accesses) as Array<[keyof typeof accesses, (typeof accesses)[keyof typeof accesses]]>) {
    for (const [userName, user] of Object.entries(users) as Array<[keyof typeof users, (typeof users)[keyof typeof users]]>) {
      it(`${accessName} action, ${userName} user: ${expected[accessName][userName] ? "allowed" : "denied"}`, async () => {
        vi.mocked(getCurrentUser).mockResolvedValue(user as never);
        const handler = vi.fn(async () => ({ ok: true, message: "done" }));
        const action = defineAction({ input: z.object({}), access: access as never }, handler);
        const result = await action(null, new FormData());
        expect(result?.ok).toBe(expected[accessName][userName]);
        expect(handler).toHaveBeenCalledTimes(expected[accessName][userName] ? 1 : 0);
        if (!expected[accessName][userName]) expect(result?.message).toMatch(user ? /can't do that/ : /Sign in/);
      });
    }
  }

  it("returns field errors for invalid input without running the handler", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const handler = vi.fn();
    const action = defineAction({ input: z.object({ pincode: z.string().regex(/^\d{6}$/, "Enter a 6-digit pincode.") }), access: "public" }, handler);
    const fd = new FormData();
    fd.set("pincode", "12");
    expect(await action(null, fd)).toMatchObject({ ok: false, fieldErrors: { pincode: "Enter a 6-digit pincode." } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("hides unexpected errors behind a reference", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const action = defineAction({ input: z.object({}), access: "public" }, async () => {
      throw new Error("connection string postgres://secret");
    });
    const result = await action(null, new FormData());
    expect(result?.message).toMatch(/problem on our side/);
    expect(result?.message).not.toMatch(/secret/);
  });

  it("formDataToObject keeps repeated keys as arrays and drops Next internals", () => {
    const fd = new FormData();
    fd.append("c", "A");
    fd.append("c", "B");
    fd.append("n", "1");
    fd.append("$ACTION_ID_x", "");
    expect(formDataToObject(fd)).toEqual({ c: ["A", "B"], n: "1" });
  });
});
