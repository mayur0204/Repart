import { describe, expect, it } from "vitest";
import { CsvParseError, csvToRecords, parseCsv } from "@/lib/csv";
import { normalizePartNumber } from "@/lib/part-number";
import { partNumberPath, slugify } from "@/lib/slug";
import { categoryInput } from "@/server/services/catalogue/categories";

describe("part-number normalisation", () => {
  it("ignores case, spaces and dashes", () => {
    for (const v of ["SAMPLE-BRK-0001", "sample brk 0001", "Sample-Brk 0001", "  SAMPLE--BRK-0001 "]) {
      expect(normalizePartNumber(v)).toBe("SAMPLEBRK0001");
    }
  });

  it("keeps other characters that can matter (dots, slashes)", () => {
    expect(normalizePartNumber("ab.12/3")).toBe("AB.12/3");
  });
});

describe("slugs and part-number URLs", () => {
  it("slugifies brand names", () => {
    expect(slugify("Sample Motors")).toBe("sample-motors");
    expect(slugify("  Demo Wheels (sample) ")).toBe("demo-wheels-sample");
    expect(slugify("Crème Brûlée")).toBe("creme-brulee");
  });

  it("builds the public path with the display number encoded", () => {
    expect(partNumberPath({ brand: "Sample Aftermarket", display: "SAMPLE-BRK 0004" })).toBe("/parts/sample-aftermarket/SAMPLE-BRK%200004");
  });
});

describe("CSV parser", () => {
  it("handles quotes, escaped quotes, embedded commas and newlines", () => {
    const rows = parseCsv('a,b,c\n"x, y","say ""hi""","line1\nline2"\n');
    expect(rows).toEqual([
      { line: 1, cells: ["a", "b", "c"] },
      { line: 2, cells: ["x, y", 'say "hi"', "line1\nline2"] },
    ]);
  });

  it("handles CRLF, a BOM, trailing rows without newline and skips blank lines", () => {
    expect(parseCsv("﻿a,b\r\n\r\n1,2\r\n3,4")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 3, cells: ["1", "2"] },
      { line: 4, cells: ["3", "4"] },
    ]);
  });

  it("keeps empty fields", () => {
    expect(parseCsv("a,,c\n,,\n")[1]?.cells).toEqual(["", "", ""]);
  });

  it("reports unclosed quotes and stray quotes with the line", () => {
    expect(() => parseCsv('a\n"open')).toThrow(CsvParseError);
    expect(() => parseCsv('a\nab"c')).toThrow(/Line 2/);
  });

  it("csvToRecords lower-cases headers and trims values", () => {
    const { headers, records } = csvToRecords("Name, Slug\n Sample Motors , sample-motors\n");
    expect(headers).toEqual(["name", "slug"]);
    expect(records).toEqual([{ line: 2, values: { name: "Sample Motors", slug: "sample-motors" } }]);
  });
});

describe("category validation", () => {
  const base = {
    name: "Brake pads",
    inspectionTier: "C_ALWAYS",
    shippingRestriction: "NONE",
    packagingGuide: "Wrap each pad in paper and pack in a small box.",
    conditionChecklist: '[{"id":"cracks","question":"Any cracks?","weight":40,"badAnswer":"YES","blocksListing":false}]',
    photoGuide: '[{"shotType":"front","label":"Front","instructions":"Whole part in daylight.","required":true}]',
  };

  it("converts rupees to paise and parses the JSON lists", () => {
    const v = categoryInput.parse({ ...base, optionalCheckFeeRupees: "149.5", isSafetyCritical: "on" });
    expect(v.optionalCheckFeeRupees).toBe(14950);
    expect(v.isSafetyCritical).toBe(true);
    expect(v.conditionChecklist[0]?.id).toBe("cracks");
  });

  it("rejects invalid JSON, empty lists and duplicate ids with a readable message", () => {
    expect(categoryInput.safeParse({ ...base, conditionChecklist: "[{" }).error?.issues[0]?.message).toMatch(/isn't valid JSON/);
    expect(categoryInput.safeParse({ ...base, photoGuide: "[]" }).success).toBe(false);
    const dup = '[{"shotType":"a","label":"A1","instructions":"Take it.","required":true},{"shotType":"a","label":"A2","instructions":"Take it.","required":true}]';
    expect(categoryInput.safeParse({ ...base, photoGuide: dup }).error?.issues[0]?.message).toMatch(/unique/);
  });

  it("needs a threshold for Tier B and forbids Tier A for safety-critical parts", () => {
    expect(categoryInput.safeParse({ ...base, inspectionTier: "B_CONDITIONAL" }).error?.issues[0]?.path).toEqual(["inspectionValueThresholdRupees"]);
    expect(categoryInput.safeParse({ ...base, inspectionTier: "B_CONDITIONAL", inspectionValueThresholdRupees: "5000" }).success).toBe(true);
    expect(categoryInput.safeParse({ ...base, inspectionTier: "A_AUTOMATED", isSafetyCritical: "on" }).error?.issues[0]?.path).toEqual(["inspectionTier"]);
  });
});
