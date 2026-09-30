import { describe, expect, it } from "vitest";
import { createMockShippingProvider, signMockTracking } from "@/server/adapters/shipping/mock";
import { hoursLeft, orderTimeline } from "@/lib/order-state";
import { cancellationRuleFor, pickupSlots, resolveSlot } from "@/server/services/order/fulfilment";
import { DEFAULT_SETTINGS } from "@/server/services/settings/schema";

const RULES = DEFAULT_SETTINGS.orders.buyerCancellationRules;

describe("mock pickup slots: next 3 business days, 10:00–18:00 IST, four 2-hour slots", () => {
  it("offers 12 slots on weekdays only, at 10, 12, 14 and 16 IST", () => {
    const friday = new Date("2026-10-02T06:00:00Z"); // Friday 11:30 IST
    const slots = pickupSlots(friday);
    expect(slots).toHaveLength(12);
    const days = [...new Set(slots.map((s) => new Date(s.start.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10)))];
    expect(days).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]); // Mon–Wed, weekend skipped
    expect(slots.slice(0, 4).map((s) => s.start.toISOString())).toEqual(["2026-10-05T04:30:00.000Z", "2026-10-05T06:30:00.000Z", "2026-10-05T08:30:00.000Z", "2026-10-05T10:30:00.000Z"]);
    for (const s of slots) expect(s.end.getTime() - s.start.getTime()).toBe(2 * 3_600_000);
  });

  it("is deterministic and never offers today", () => {
    const now = new Date("2026-09-30T02:00:00Z");
    expect(pickupSlots(now)).toEqual(pickupSlots(now));
    expect(pickupSlots(now)[0]!.start.getTime()).toBeGreaterThan(now.getTime() + 12 * 3_600_000);
  });

  it("only accepts a slot the server offers right now (made-up, malformed or stale slots are refused)", () => {
    const now = new Date("2026-09-30T06:00:00Z");
    const slot = pickupSlots(now)[3]!;
    expect(resolveSlot(slot.id, now)).toEqual(slot);
    expect(() => resolveSlot("2026-10-01T05:00:00.000Z", now)).toThrow(/pickup slots shown/);
    expect(() => resolveSlot(undefined, now)).toThrow(/pickup slots shown/);
    const weekLater = new Date(now.getTime() + 7 * 86_400_000);
    expect(() => resolveSlot(slot.id, weekLater)).toThrow(/pickup slots shown/);
  });
});

describe("buyer cancellation uses the admin-configured rules (A-5 defaults)", () => {
  it.each([
    ["PAID_HELD", { refundItem: true, refundShipping: true, refundCheck: true }],
    ["AWAITING_SELLER", { refundItem: true, refundShipping: true, refundCheck: true }],
    ["INSPECTION_SCHEDULED", { refundItem: true, refundShipping: true, refundCheck: true }],
    ["INSPECTION_PASSED", { refundItem: true, refundShipping: true, refundCheck: false }],
    ["PICKUP_SCHEDULED", { refundItem: true, refundShipping: true, refundCheck: false }],
    ["AWAITING_HANDOVER", { refundItem: true, refundShipping: true, refundCheck: false }],
  ])("%s", (state, expected) => {
    expect(cancellationRuleFor(state, RULES)).toMatchObject(expected);
  });
  it("not after pickup, and not before payment", () => {
    for (const s of ["CREATED", "IN_TRANSIT", "DELIVERED", "ACCEPTANCE_WINDOW", "COMPLETED", "CANCELLED", "DISPUTED"]) expect(cancellationRuleFor(s, RULES)).toBeNull();
  });
  it("follows the configured table, not a hard-coded one", () => {
    const strict = [{ beforeState: "AWAITING_SELLER", refundItem: true, refundShipping: false, refundCheck: false }];
    expect(cancellationRuleFor("PAID_HELD", strict)).toMatchObject({ refundShipping: false });
    expect(cancellationRuleFor("AWAITING_SELLER", strict)).toBeNull();
  });
});

describe("order timeline", () => {
  const at = (s: string) => new Date(`2026-09-30T${s}:00Z`);
  it("shows this order's delivery path with the current step", () => {
    const steps = orderTimeline({ state: "IN_TRANSIT", inspection: false, delivery: true, events: [{ toState: "CREATED", createdAt: at("01:00") }, { toState: "PAID_HELD", createdAt: at("01:05") }, { toState: "AWAITING_SELLER", createdAt: at("01:05") }, { toState: "PICKUP_SCHEDULED", createdAt: at("03:00") }, { toState: "IN_TRANSIT", createdAt: at("09:00") }] });
    expect(steps.map((s) => s.state)).toEqual(["CREATED", "PAID_HELD", "AWAITING_SELLER", "PICKUP_SCHEDULED", "IN_TRANSIT", "DELIVERED", "ACCEPTANCE_WINDOW", "COMPLETED"]);
    expect(steps.filter((s) => s.status === "current").map((s) => s.state)).toEqual(["IN_TRANSIT"]);
    expect(steps.find((s) => s.state === "DELIVERED")!.status).toBe("upcoming");
    expect(steps[3]!.at).toEqual(at("03:00"));
  });
  it("includes the Partner Check for inspected orders and the handover for local pickup", () => {
    expect(orderTimeline({ state: "AWAITING_SELLER", inspection: true, delivery: true, events: [] }).map((s) => s.state)).toContain("INSPECTION_PASSED");
    const local = orderTimeline({ state: "AWAITING_HANDOVER", inspection: false, delivery: false, events: [] }).map((s) => s.state);
    expect(local).toContain("AWAITING_HANDOVER");
    expect(local).not.toContain("IN_TRANSIT");
  });
  it("a cancelled order shows the steps it reached, then Cancelled as current", () => {
    const steps = orderTimeline({ state: "CANCELLED", inspection: false, delivery: true, events: [{ toState: "CREATED", createdAt: at("01:00") }, { toState: "PAID_HELD", createdAt: at("01:05") }, { toState: "AWAITING_SELLER", createdAt: at("01:05") }, { toState: "CANCELLED", createdAt: at("05:00") }] });
    expect(steps.map((s) => `${s.state}:${s.status}`)).toEqual(["CREATED:done", "PAID_HELD:done", "AWAITING_SELLER:done", "CANCELLED:current"]);
  });
  it("countdown hours round up and stop at zero", () => {
    const now = at("00:00");
    expect(hoursLeft(new Date(now.getTime() + 90 * 60_000), now)).toBe(2);
    expect(hoursLeft(new Date(now.getTime() - 1), now)).toBe(0);
    expect(hoursLeft(null, now)).toBeNull();
  });
});

describe("mock courier webhook signature (timestamp + raw body, 5-minute window)", () => {
  const secret = "shipping-secret-0123456789";
  const shipping = createMockShippingProvider({ webhookSecret: secret });
  const body = JSON.stringify({ providerEventId: "e1", shipmentId: "s1", status: "PICKED_UP", at: "2026-09-30T00:00:00Z" });
  it("accepts a correctly signed, fresh event and rejects forged, tampered, stale and unsigned ones", () => {
    const now = Date.now();
    expect(shipping.verifyWebhook(body, signMockTracking(secret, body, now))).toBe(true);
    expect(shipping.verifyWebhook(body, signMockTracking("wrong-secret-0000000", body, now))).toBe(false);
    expect(shipping.verifyWebhook(body.replace("PICKED_UP", "DELIVERED"), signMockTracking(secret, body, now))).toBe(false);
    expect(shipping.verifyWebhook(body, signMockTracking(secret, body, now - 6 * 60_000))).toBe(false);
    expect(shipping.verifyWebhook(body, new Headers())).toBe(false);
  });
});
