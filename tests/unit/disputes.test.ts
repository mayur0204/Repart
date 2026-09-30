import { describe, expect, it, vi } from "vitest";
import { HOLD_THRESHOLDS, MAX_EVIDENCE_PHOTOS, reportInput, reviewInput, sellerResponseDeadline, SELLER_RESPONSE_HOURS } from "@/server/services/order/disputes";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const resolveDispute = vi.fn(async () => {});
const bookReturn = vi.fn(async () => "not_applicable");
vi.mock("@/server/services", () => ({ orders: { resolveDispute }, disputes: { bookReturn }, fulfilment: {} }));
const currentUser = vi.fn(async () => null as unknown);
vi.mock("@/server/auth/current", () => ({ getCurrentUser: () => currentUser(), clientIp: async () => "127.0.0.1" }));

describe("M11 rules", () => {
  it("report: reason from the fixed list, description of at least 20 characters", () => {
    expect(reportInput.safeParse({ reason: "DOES_NOT_FIT", description: "Mounting holes are 5 mm off." }).success).toBe(true);
    expect(reportInput.safeParse({ reason: "DOES_NOT_FIT", description: "  too short  " }).success).toBe(false);
    expect(reportInput.safeParse({ reason: "LATE", description: "x".repeat(30) }).success).toBe(false);
    expect(MAX_EVIDENCE_PHOTOS).toBe(5);
  });
  it("review: rating is a whole number from 1 to 5; text is optional", () => {
    expect(reviewInput.parse({ rating: "3" })).toEqual({ rating: 3, text: null });
    for (const r of ["0", "6", "2.5", "", "x"]) expect(reviewInput.safeParse({ rating: r }).success).toBe(false);
  });
  it("seller response deadline is 48 hours after the report", () => {
    const at = new Date("2026-10-01T10:00:00Z");
    expect(SELLER_RESPONSE_HOURS).toBe(48);
    expect(sellerResponseDeadline(at).toISOString()).toBe("2026-10-03T10:00:00.000Z");
  });
  it("hold-deadline thresholds are 7 days, 3 days, 1 day and 12 hours", () => {
    expect(HOLD_THRESHOLDS.map((t) => t.key)).toEqual(["7d", "3d", "1d", "12h"]);
  });
});

describe("only admins can resolve a dispute", () => {
  const form = () => {
    const f = new FormData();
    f.set("orderId", "o1");
    f.set("decision", "REFUND");
    f.set("reason", "Photos show the damage");
    return f;
  };
  it("signed-out users, members, sellers and mechanics are refused; an admin's decision goes through", async () => {
    const { resolveOrderDispute } = await import("../../app/admin/orders/actions");
    for (const user of [null, { id: "b", roles: ["MEMBER"] }, { id: "m", roles: ["MEMBER", "MECHANIC"] }]) {
      currentUser.mockResolvedValueOnce(user);
      expect((await resolveOrderDispute(null, form()))?.ok).toBe(false);
    }
    expect(resolveDispute).not.toHaveBeenCalled();
    currentUser.mockResolvedValueOnce({ id: "admin", roles: ["MEMBER", "ADMIN"] });
    expect((await resolveOrderDispute(null, form()))?.ok).toBe(true);
    expect(resolveDispute).toHaveBeenCalledWith(expect.objectContaining({ userId: "admin" }), "o1", expect.objectContaining({ decision: "REFUND", reason: "Photos show the damage" }));
    expect(bookReturn).toHaveBeenCalledWith("o1");
  }, 60_000);
});
