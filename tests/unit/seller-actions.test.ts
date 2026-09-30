import { expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const fulfilment = { confirm: vi.fn(async () => ({ state: "INSPECTION_SCHEDULED" })) };
vi.mock("@/server/services", () => ({ fulfilment }));
vi.mock("@/server/auth/current", () => ({ getCurrentUser: async () => ({ id: "seller", roles: ["MEMBER"] }), clientIp: async () => "127.0.0.1" }));

// Regression (found by the M13 Partner Check e2e): the action used to drop inspectionSlot, so a seller could never
// confirm a Partner Check order in an area a garage serves.
it("confirmOrder passes the chosen Partner Check slot to the service", async () => {
  const { confirmOrder } = await import("../../app/seller/orders/actions");
  const fd = new FormData();
  fd.set("orderId", "o1");
  fd.set("slot", "2026-10-02T04:30:00.000Z");
  fd.set("inspectionSlot", "2026-10-01T04:30:00.000Z");
  expect((await confirmOrder(null, fd))?.ok).toBe(true);
  expect(fulfilment.confirm).toHaveBeenCalledWith(expect.objectContaining({ userId: "seller" }), "o1", { slot: "2026-10-02T04:30:00.000Z", inspectionSlot: "2026-10-01T04:30:00.000Z" });
}, 60_000);
