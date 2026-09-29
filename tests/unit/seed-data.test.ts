import { describe, expect, it } from "vitest";
import { CATEGORIES } from "../../prisma/seed/data/categories";
import { SAMPLE_LINKS, SAMPLE_MAKES, SAMPLE_PART_NUMBERS, SAMPLE_PINCODES } from "../../prisma/seed/data/catalogue";
import { resolveSeedTarget } from "../../prisma/seed/seed";
import { normalizePartNumber } from "../../src/lib/part-number";
import { DEFAULT_SETTINGS, settingsSchema } from "../../src/server/services/settings/schema";

const tierOf = (slug: string) => CATEGORIES.find((c) => c.slug === slug)?.inspectionTier;

describe("seed categories follow the brief's default tiers (§6)", () => {
  it.each(["brake-pads", "brake-discs", "brake-levers", "tyres", "wheels", "suspension", "steering-parts"])("%s is Tier C", (slug) =>
    expect(tierOf(slug)).toBe("C_ALWAYS"),
  );
  it.each(["exhausts", "clutch-parts", "clutch-levers", "engine-parts", "ecus-and-electricals", "lights"])("%s is Tier B", (slug) =>
    expect(tierOf(slug)).toBe("B_CONDITIONAL"),
  );
  it.each(["mirrors", "body-panels-and-fairings", "seats", "grips", "accessories"])("%s is Tier A", (slug) =>
    expect(tierOf(slug)).toBe("A_AUTOMATED"),
  );

  it("every leaf category has a checklist and at least 3 photo shots", () => {
    for (const c of CATEGORIES.filter((c) => c.parentSlug)) {
      expect(c.conditionChecklist.length, c.slug).toBeGreaterThan(0);
      expect(c.photoGuide.length, c.slug).toBeGreaterThanOrEqual(3);
    }
  });

  it("checklist question ids are unique within each category", () => {
    for (const c of CATEGORIES) {
      const ids = c.conditionChecklist.map((q) => q.id);
      expect(new Set(ids).size, c.slug).toBe(ids.length);
    }
  });
});

describe("seed catalogue is clearly SAMPLE data (D-4)", () => {
  it("uses only fictional sample makes", () => {
    for (const m of SAMPLE_MAKES) expect(m.name).toMatch(/Sample|sample/);
  });

  it("uses the SAMPLE- part-number format", () => {
    for (const pn of SAMPLE_PART_NUMBERS) {
      expect(pn.display).toMatch(/^SAMPLE-/);
      expect(normalizePartNumber(pn.display)).toMatch(/^SAMPLE[A-Z]{3}\d{4}$/);
    }
  });

  it("FITS_WITH_MODIFICATION links carry notes", () => {
    for (const l of SAMPLE_LINKS.filter((l) => l.type === "FITS_WITH_MODIFICATION")) expect(l.notes?.trim()).toBeTruthy();
  });

  it("sample pincodes are labelled as sample places", () => {
    for (const p of SAMPLE_PINCODES) expect(p.district).toMatch(/^Sample /);
  });
});

describe("settings and seed guards", () => {
  it("default settings are valid and match brief defaults", () => {
    const s = settingsSchema.parse(DEFAULT_SETTINGS);
    expect(s.fees.platformFeeBps).toBe(0);
    expect(s.orders.sellerConfirmHours).toBe(24);
    expect(s.orders.acceptanceWindowHours).toBe(48);
    expect(s.orders.providerMaxHoldDays).toBe(45);
    expect(s.orders.disputeDeadlineWarningDays).toBe(7);
    expect(s.inspections.auditPercent).toBe(5);
  });

  it("seed requires an explicit target and refuses production", () => {
    expect(() => resolveSeedTarget([], {})).toThrow(/--target/);
    expect(() => resolveSeedTarget(["--target=dev"], { NODE_ENV: "production", DIRECT_URL: "postgresql://x" })).toThrow(/production/);
    expect(() =>
      resolveSeedTarget(["--target=test"], { TEST_DATABASE_URL: "postgresql://p:w@db.ref.supabase.co:5432/postgres" }),
    ).toThrow(/non-local/);
  });
});

describe("part number normalisation", () => {
  it("uppercases and strips spaces and dashes", () => {
    expect(normalizePartNumber("sample-brk 0004")).toBe("SAMPLEBRK0004");
    expect(normalizePartNumber(" ab - 12  34 ")).toBe("AB1234");
  });
});
