import { describe, expect, it } from "vitest";
import { formatDate, formatKm, formatPrice } from "@/lib/format";

describe("formatPrice", () => {
  it("uses Indian digit grouping with no decimals for whole rupees", () => {
    expect(formatPrice(7_500_000)).toBe("₹75,000");
    expect(formatPrice(12_500_000)).toBe("₹1,25,000");
    expect(formatPrice(0)).toBe("₹0");
  });

  it("shows two decimals when there are paise", () => {
    expect(formatPrice(10_050)).toBe("₹100.50");
  });

  it("rejects non-integer paise", () => {
    expect(() => formatPrice(10.5)).toThrow(/integer paise/);
  });
});

describe("formatDate", () => {
  it("renders 28 Sep 2026 in India time", () => {
    expect(formatDate(new Date("2026-09-28T10:00:00+05:30"))).toBe("28 Sep 2026");
    // 20:00 UTC on the 27th is already the 28th in India.
    expect(formatDate("2026-09-27T20:00:00Z")).toBe("28 Sep 2026");
  });
});

describe("formatKm", () => {
  it("formats kilometres with Indian grouping", () => {
    expect(formatKm(12)).toBe("12 km");
    expect(formatKm(1250)).toBe("1,250 km");
    expect(formatKm(0.84)).toBe("0.8 km");
  });
});
