import { describe, expect, it } from "vitest";
import { istDay, parseInspectionForm } from "@/server/services/inspection/inspection";
import { selectedForAudit } from "@/server/services/risk/rules";

describe("audit selection (PLAN.md §6.3): hash(orderId + settingsVersion) mod 10000 < auditPercent × 100", () => {
  it("is deterministic for the same order and settings version", () => {
    for (const id of ["cm1", "cm2", "order-abc"]) expect(selectedForAudit(id, 3, 5)).toBe(selectedForAudit(id, 3, 5));
  });
  it("the settings version is part of the hash", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `order_${i}`);
    const a = ids.map((id) => selectedForAudit(id, 1, 50));
    const b = ids.map((id) => selectedForAudit(id, 2, 50));
    expect(a).not.toEqual(b);
  });
  it("0% never selects, 100% always selects, 5% selects roughly 1 in 20", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `o${i}`);
    expect(ids.some((id) => selectedForAudit(id, 1, 0))).toBe(false);
    expect(ids.every((id) => selectedForAudit(id, 1, 100))).toBe(true);
    const n = ids.filter((id) => selectedForAudit(id, 1, 5)).length;
    expect(n).toBeGreaterThan(120);
    expect(n).toBeLessThan(290);
  });
});

describe("inspection form", () => {
  const checklist = [
    { id: "crack", question: "Any cracks?" },
    { id: "thread", question: "Threads intact?" },
  ];
  const base = { outcome: "PASS", check_crack: "no", check_thread: "yes" };

  it("records checklist answers and free-form measured rows (key, label, value, unit)", () => {
    const f = parseInspectionForm({ ...base, m0_label: "Pad thickness", m0_value: "4.2", m0_unit: "mm", m1_label: "", m1_value: "" }, checklist);
    expect(f.checklistResults).toEqual([
      { id: "crack", question: "Any cracks?", answer: "no" },
      { id: "thread", question: "Threads intact?", answer: "yes" },
    ]);
    expect(f.measuredValues).toEqual([{ key: "pad_thickness", label: "Pad thickness", value: "4.2", unit: "mm" }]);
  });

  it("every checklist question needs an answer, and a half-filled measurement is refused", () => {
    expect(() => parseInspectionForm({ outcome: "PASS", check_crack: "no" }, checklist)).toThrow();
    expect(() => parseInspectionForm({ ...base, m2_label: "Runout" }, checklist)).toThrow();
  });

  it("an outcome is required; pass with notes and fail need notes", () => {
    expect(() => parseInspectionForm({ ...base, outcome: "MAYBE" }, checklist)).toThrow();
    expect(() => parseInspectionForm({ ...base, outcome: "FAIL", notes: "bad" }, checklist)).toThrow();
    expect(parseInspectionForm({ ...base, outcome: "FAIL", notes: "Deep crack on the mounting tab" }, checklist).outcome).toBe("FAIL");
    expect(parseInspectionForm({ ...base, outcome: "PASS_WITH_NOTES", notes: "Light scratches on the housing" }, checklist).notes).toBe("Light scratches on the housing");
  });
});

describe("IST day boundaries (capacity is per garage per day)", () => {
  it("groups instants by the Indian calendar day", () => {
    const [start, end] = istDay(new Date("2026-10-05T04:30:00Z")); // 10:00 IST
    expect(start.toISOString()).toBe("2026-10-04T18:30:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
    expect(istDay(new Date("2026-10-05T18:29:59Z"))[0]).toEqual(start); // 23:59 IST, same day
    expect(istDay(new Date("2026-10-05T18:30:00Z"))[0]).toEqual(end); // midnight IST, next day
  });
});
