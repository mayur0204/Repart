import { describe, expect, it, vi } from "vitest";
import {
  brightness,
  detectContactDetails,
  gradeFromChecklist,
  hammingDistance,
  laplacianVariance,
  perceptualHash,
  photoFileProblem,
  qualityWarnings,
  sniffImageType,
  type ChecklistItem,
} from "@/lib/listing";
import { checkSteps, type StepInput } from "@/server/services/listing/steps";
import { canTransition } from "@/server/services/listing/state";

const thresholds = { likeNewMin: 90, goodMin: 70, fairMin: 40 };
const items: ChecklistItem[] = [
  { id: "cracks", question: "Any cracks?", weight: 40, badAnswer: "YES", blocksListing: false },
  { id: "worn", question: "Worn below the limit?", weight: 25, badAnswer: "YES", blocksListing: true },
  { id: "works", question: "Does it work?", weight: 20, badAnswer: "NO", blocksListing: false },
];

describe("condition grade", () => {
  it("scores 100 minus the weights of bad answers and maps to the settings thresholds", () => {
    expect(gradeFromChecklist(items, { cracks: "NO", worn: "NO", works: "YES" }, thresholds)).toMatchObject({ score: 100, grade: "LIKE_NEW", blocking: [], unanswered: [] });
    expect(gradeFromChecklist(items, { cracks: "NO", worn: "NO", works: "NO" }, thresholds)).toMatchObject({ score: 80, grade: "GOOD" });
    expect(gradeFromChecklist(items, { cracks: "YES", worn: "NO", works: "YES" }, thresholds)).toMatchObject({ score: 60, grade: "FAIR" });
    expect(gradeFromChecklist(items, { cracks: "YES", worn: "NO", works: "NO" }, thresholds)).toMatchObject({ score: 40, grade: "FAIR" });
    expect(gradeFromChecklist(items, { cracks: "YES", worn: "YES", works: "NO" }, thresholds)).toMatchObject({ score: 15, grade: "FOR_REPAIR" });
  });

  it("reports unanswered and blocking questions", () => {
    const r = gradeFromChecklist(items, { worn: "YES" }, thresholds);
    expect(r.unanswered).toEqual(["cracks", "works"]);
    expect(r.blocking).toEqual(["Worn below the limit?"]);
  });
});

describe("contact details warning", () => {
  it("catches phone numbers, emails, UPI ids and messaging apps", () => {
    expect(detectContactDetails("call 98765 43210 after 6")).toContain("phone number");
    expect(detectContactDetails("+91-9876543210")).toContain("phone number");
    expect(detectContactDetails("mail me at rider@example.com")).toContain("email address");
    expect(detectContactDetails("pay to rider@okaxis")).toContain("UPI id");
    expect(detectContactDetails("WhatsApp me")).toContain("messaging app");
  });

  it("doesn't flag ordinary listing text", () => {
    expect(detectContactDetails("Removed at 12,000 km. Part number SAMPLE-BRK-0001, fits 2019 models, 150 cc.")).toEqual([]);
  });
});

describe("photo files", () => {
  it("checks declared type and size", () => {
    expect(photoFileProblem({ type: "image/jpeg", size: 1000 })).toBeNull();
    expect(photoFileProblem({ type: "image/heic", size: 1000 })).toMatch(/JPEG, PNG or WebP/);
    expect(photoFileProblem({ type: "image/png", size: 0 })).toMatch(/empty/);
    expect(photoFileProblem({ type: "image/png", size: 11 * 1024 * 1024 })).toMatch(/over 10 MB/);
  });

  it("sniffs the real type from magic bytes", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
    expect(sniffImageType(new TextEncoder().encode("RIFF....WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
  });
});

describe("image quality maths", () => {
  const flat = (v: number, n = 64 * 64) => new Uint8Array(n).fill(v);
  const checker = (w: number, h: number) => Uint8Array.from({ length: w * h }, (_, i) => ((i % w) + Math.floor(i / w)) % 2 ? 255 : 0);

  it("brightness is the mean level", () => {
    expect(brightness(flat(30))).toBe(30);
    expect(brightness(checker(8, 8))).toBe(127.5);
  });

  it("blur: a flat image has zero Laplacian variance; sharp edges have a lot", () => {
    expect(laplacianVariance(flat(120), 64, 64)).toBe(0);
    expect(laplacianVariance(checker(64, 64), 64, 64)).toBeGreaterThan(10_000);
  });

  it("perceptual hash is 64 bits, stable for the same image, and differs for different ones", () => {
    const gradient = Uint8Array.from({ length: 1024 }, (_, i) => (i % 32) * 8);
    const other = Uint8Array.from({ length: 1024 }, (_, i) => Math.floor(i / 32) * 8);
    const h1 = perceptualHash(gradient);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(perceptualHash(gradient)).toBe(h1);
    expect(hammingDistance(h1, h1)).toBe(0);
    expect(hammingDistance(h1, perceptualHash(other))).toBeGreaterThan(10);
    expect(() => perceptualHash(new Uint8Array(10))).toThrow();
  });

  it("turns metrics into plain warnings using the settings thresholds", () => {
    const t = { minBrightness: 40, maxBrightness: 225, blurThreshold: 100 };
    expect(qualityWarnings({ brightness: 20, blur: 500 }, t)[0]).toMatch(/too dark/);
    expect(qualityWarnings({ brightness: 240, blur: 500 }, t)[0]).toMatch(/too bright/);
    expect(qualityWarnings({ brightness: 120, blur: 5 }, t)[0]).toMatch(/blurry/);
    expect(qualityWarnings({ brightness: 120, blur: 500 }, t)).toEqual([]);
  });
});

describe("wizard step checks", () => {
  const complete: StepInput = {
    listing: { partNumberId: "p", partName: "Pads", categoryId: "c", checklistAnswers: { cracks: "NO", worn: "NO", works: "YES" }, description: "x".repeat(40), pricePaise: 50000, pickupAddressId: "a", weightBand: "UNDER_1KG", dimensionBand: "SMALL" },
    hasSellerBike: true,
    checklist: items,
    requiredShots: [{ shotType: "front", label: "Front" }],
    photos: [{ shotType: "front", status: "ready" }, { shotType: "back", status: "ready" }, { shotType: "extra", status: "ready" }],
    settings: { minPhotos: 3, grading: thresholds },
  };

  it("a complete listing has no problems", () => {
    expect(Object.values(checkSteps(complete)).flat()).toEqual([]);
  });

  it("lists what's missing per step, and blocks review", () => {
    const r = checkSteps({
      ...complete,
      hasSellerBike: false,
      listing: { ...complete.listing, partNumberId: null, description: "short", pricePaise: null },
      photos: [{ shotType: "back", status: "processing" }, { shotType: "front", status: "failed" }],
    });
    expect(r.bike).toHaveLength(1);
    expect(r.part[0]).toMatch(/catalogue/);
    expect(r.photos.join(" ")).toMatch(/Wait for your photos.*Remove the photos.*at least 3 photos.*"Front"/);
    expect(r.details[0]).toMatch(/at least 30/);
    expect(r.price).toEqual(["Set a price."]);
    expect(r.review).toHaveLength(1);
  });

  it("a blocking checklist answer stops the listing", () => {
    const r = checkSteps({ ...complete, listing: { ...complete.listing, checklistAnswers: { cracks: "NO", worn: "YES", works: "YES" } } });
    expect(r.condition[0]).toMatch(/can't be listed/);
  });
});

describe("M4 listing transitions", () => {
  it("allows only the seller events of the state machine", () => {
    expect(canTransition("DRAFT", "submit")).toBe(true);
    expect(canTransition("CHANGES_REQUESTED", "resubmit")).toBe(true);
    expect(canTransition("CHANGES_REQUESTED", "submit")).toBe(false);
    expect(canTransition("LIVE", "withdraw")).toBe(true);
    for (const s of ["SUBMITTED", "SCREENING", "RESERVED", "SOLD", "REJECTED", "WITHDRAWN"] as const) expect(canTransition(s, "withdraw")).toBe(false);
  });
});

vi.mock("@/server/auth/current", () => ({ getCurrentUser: vi.fn(async () => null), clientIp: vi.fn(async () => "127.0.0.1") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("sell actions and the photos route need a signed-in member", async () => {
  const actions = await import("../../app/sell/actions");
  const route = await import("../../app/api/listings/[id]/photos/route");

  for (const [name, action] of Object.entries(actions)) {
    it(`${name} refuses anonymous users`, async () => {
      const result = await (action as (p: null, f: FormData) => Promise<{ ok: boolean; message?: string } | null>)(null, new FormData());
      expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/Sign in/) });
    });
  }

  it("GET /api/listings/[id]/photos returns 401 when signed out", async () => {
    const res = await route.GET(new Request("http://x/api/listings/abc/photos"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(401);
  });
});
