import { describe, expect, it, vi } from "vitest";
import { isOnTime } from "@/server/services/inspection/inspection";
import { isMaterialPriceChange } from "@/server/services/inspection/label";
import { DEFAULT_SETTINGS } from "@/server/services/settings/schema";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const reassign = vi.fn(async () => "insp_1");
vi.mock("@/server/services", () => ({ inspections: { reassign } }));
const currentUser = vi.fn(async () => ({ id: "u_member", roles: ["MEMBER"] }) as unknown);
vi.mock("@/server/auth/current", () => ({ getCurrentUser: () => currentUser(), clientIp: async () => "127.0.0.1" }));

// Slot: Tuesday 6 Oct 2026, 10:00–12:00 IST = 04:30–06:30 UTC.
const slot = new Date("2026-10-06T04:30:00Z");

describe("garage on-time rule: completed any time on the scheduled IST date", () => {
  it("completion during the slot is on time", () => {
    expect(isOnTime(slot, new Date("2026-10-06T05:15:00Z"))).toBe(true); // 10:45 IST
  });
  it("completion later the same IST day is on time", () => {
    expect(isOnTime(slot, new Date("2026-10-06T13:00:00Z"))).toBe(true); // 18:30 IST
    expect(isOnTime(slot, new Date("2026-10-06T18:29:59Z"))).toBe(true); // 23:59:59 IST
  });
  it("completion after midnight IST is late", () => {
    expect(isOnTime(slot, new Date("2026-10-06T18:35:00Z"))).toBe(false); // Wed 00:05 IST
    expect(isOnTime(slot, new Date("2026-10-07T06:00:00Z"))).toBe(false);
  });
  it("uses the IST date, not the UTC date", () => {
    // 20:00 UTC on 5 Oct is already 01:30 IST on 6 Oct: still the scheduled date in IST.
    const early = new Date("2026-10-05T20:00:00Z");
    expect(isOnTime(slot, early)).toBe(true);
    // 18:40 UTC on 6 Oct is 00:10 IST on 7 Oct: late, although the UTC date is still the 6th.
    expect(isOnTime(slot, new Date("2026-10-06T18:40:00Z"))).toBe(false);
  });
});

describe("material price change (PLAN §5.1 L9, settings.risk.materialPriceChangePercent = 20)", () => {
  it("only a change above the configured percentage is material", () => {
    expect(isMaterialPriceChange(100_000, 120_000, DEFAULT_SETTINGS)).toBe(false); // exactly 20%
    expect(isMaterialPriceChange(100_000, 120_100, DEFAULT_SETTINGS)).toBe(true);
    expect(isMaterialPriceChange(100_000, 79_000, DEFAULT_SETTINGS)).toBe(true);
    expect(isMaterialPriceChange(null, 50_000, DEFAULT_SETTINGS)).toBe(false); // first price on a draft
  });
});

describe("inspection reassignment is admin only", () => {
  const form = () => {
    const f = new FormData();
    f.set("orderId", "o1");
    f.set("choice", "g1|2026-10-06T04:30:00.000Z");
    f.set("reason", "Mechanic unavailable");
    return f;
  };
  it("a member (or mechanic) can't reassign; an admin can", async () => {
    const { reassignInspection } = await import("../../app/admin/mechanics/actions");
    for (const roles of [["MEMBER"], ["MEMBER", "MECHANIC"]]) {
      currentUser.mockResolvedValueOnce({ id: "u_x", roles });
      const r = await reassignInspection(null, form());
      expect(r?.ok).toBe(false);
    }
    expect(reassign).not.toHaveBeenCalled();
    currentUser.mockResolvedValueOnce({ id: "u_admin", roles: ["MEMBER", "ADMIN"] });
    expect((await reassignInspection(null, form()))?.ok).toBe(true);
    expect(reassign).toHaveBeenCalledWith(expect.objectContaining({ userId: "u_admin" }), expect.objectContaining({ choice: "g1|2026-10-06T04:30:00.000Z" }));
  }, 60_000);
});
