import { describe, expect, it, vi } from "vitest";
import { CONTACT_MASK, detectContactDetails, maskContactDetails } from "@/lib/listing";

const M = CONTACT_MASK;
const masked = (text: string) => maskContactDetails(text) !== text; // how the server sets wasMasked

describe("contact masking suite (PLAN.md §9 M7: phones incl. spaced digits and words, emails, UPI)", () => {
  it.each([
    ["9876543210", M],
    ["+919876543210", M],
    ["+91 98765 43210", M],
    ["98765-43210", M],
    ["9 8 7 6 5 4 3 2 1 0", M],
    ["98765.43210", M],
    ["(987) 654-3210", M],
    ["0 9876543210", `0 ${M}`],
  ])("phone %s", (input, out) => expect(maskContactDetails(input)).toBe(out));

  it("phones written with number words, fully or mixed, with double/triple", () => {
    expect(maskContactDetails("call nine eight seven six five four three two one zero now")).toBe(`call ${M} now`);
    expect(maskContactDetails("nine 8 seven 6 five 4 three 2 one 0")).toBe(M);
    expect(maskContactDetails("double nine eight seven six five four three two one")).toBe(M);
    expect(maskContactDetails("Nine-Eight-Seven-Six-Five-Four-Three-Two-One-Zero.")).toBe(`${M}.`); // punctuation kept
    expect(detectContactDetails("nine eight seven six five four three two one zero")).toContain("phone number");
  });

  it("emails and UPI handles", () => {
    expect(maskContactDetails("mail rider.one+parts@example.co.in today")).toBe(`mail ${M} today`);
    expect(maskContactDetails("pay rider@okaxis or 9876543210@ybl")).toBe(`pay ${M} or ${M}`);
  });

  it("several contact details in one message", () => {
    expect(maskContactDetails("Call 98765 43210, mail a@b.com, UPI me@paytm, or nine eight seven six five four three two one zero")).toBe(
      `Call ${M}, mail ${M}, UPI ${M}, or ${M}`,
    );
  });

  it.each([
    "Is it still available? Can you do ₹650?",
    "Fits 2018 2019 2020 2021 models, 150 cc.",
    "Part number SAMPLE-BRK-0001, about 12,000 km used.",
    "I have one bike and two helmets, three spare pads.",
    "Pickup on 12/05/2026 at 10:30 works for me.",
    "Order 1234 5678 is for two pads.",
    "Price 8,500 for 2 pads and 1,200 for the mirror.",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(maskContactDetails(text)).toBe(text);
    expect(masked(text)).toBe(false);
  });

  it("wasMasked is true exactly when something was hidden", () => {
    expect(masked("ring me on 9876543210")).toBe(true);
    expect(masked("see you at the shop")).toBe(false);
  });
});

vi.mock("@/server/auth/current", () => ({ getCurrentUser: vi.fn(async () => null), clientIp: vi.fn(async () => "127.0.0.1") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("messaging actions and polling route need a signed-in member", async () => {
  const actions = await import("../../app/messages/actions");
  for (const [name, action] of Object.entries(actions)) {
    it(`${name} refuses anonymous users`, async () => {
      const r = await (action as (p: null, f: FormData) => Promise<{ ok: boolean; message?: string } | null>)(null, new FormData());
      expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/Sign in/) });
    }, 30_000);
  }
  it("GET /api/messages/[conversationId] returns 401 signed out", async () => {
    const { GET } = await import("../../app/api/messages/[conversationId]/route");
    expect((await GET(new Request("http://x/api/messages/c1"), { params: Promise.resolve({ conversationId: "c1" }) })).status).toBe(401);
  }, 30_000);
});
