import { describe, expect, it, vi } from "vitest";
import { computeAgreement, csvCell, csvLine, EXPORT_COLUMNS, isAutomatedPass, type AgreementInput } from "@/server/services/admin/admin";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const svc = { moderateReport: vi.fn(async () => {}), changeRole: vi.fn(async () => {}), changeStatus: vi.fn(async () => {}), auditExport: vi.fn(async () => {}), exportStream: vi.fn(() => new ReadableStream()) };
vi.mock("@/server/services", () => ({ admin: svc }));
const currentUser = vi.fn(async () => null as unknown);
vi.mock("@/server/auth/current", () => ({ getCurrentUser: () => currentUser(), clientIp: async () => "127.0.0.1" }));

const r = (category: string, automatedPass: boolean | null, mechanicOutcome: AgreementInput["mechanicOutcome"]): AgreementInput => ({ category, automatedPass, mechanicOutcome });

describe("agreement maths", () => {
  it("zero inspections gives a 0% false-pass rate, never NaN", () => {
    const { total, byCategory } = computeAgreement([]);
    expect(total).toMatchObject({ inspected: 0, falsePass: 0, falsePassRate: 0 });
    expect(byCategory).toEqual([]);
  });

  it("all pass: no false passes", () => {
    const { total } = computeAgreement([r("Brakes", true, "PASS"), r("Brakes", true, "PASS")]);
    expect(total).toMatchObject({ inspected: 2, automatedPass: 2, mechanicPass: 2, mechanicFail: 0, falsePass: 0, falsePassRate: 0 });
  });

  it("all fail after an automated pass: every one is a false pass", () => {
    const { total } = computeAgreement([r("Brakes", true, "FAIL"), r("Brakes", true, "FAIL")]);
    expect(total).toMatchObject({ falsePass: 2, falsePassRate: 1 });
  });

  it("mixed results: false-pass = automated pass AND mechanic FAIL, divided by all inspected", () => {
    const { total } = computeAgreement([r("A", true, "FAIL"), r("A", false, "FAIL"), r("A", true, "PASS"), r("A", false, "PASS")]);
    expect(total).toMatchObject({ inspected: 4, automatedPass: 2, automatedNonPass: 2, mechanicPass: 2, mechanicFail: 2, falsePass: 1, falsePassRate: 0.25 });
  });

  it("PASS_WITH_NOTES counts as a mechanic pass", () => {
    const { total } = computeAgreement([r("A", true, "PASS_WITH_NOTES")]);
    expect(total).toMatchObject({ mechanicPass: 1, mechanicFail: 0, falsePass: 0 });
  });

  it("groups by category with a separate overall total; unassessed listings are counted, not guessed", () => {
    const { byCategory, total } = computeAgreement([r("Mirrors", true, "FAIL"), r("Brakes", null, "FAIL"), r("Brakes", false, "PASS")]);
    expect(byCategory.map((c) => [c.category, c.inspected, c.falsePass, c.unassessed])).toEqual([
      ["Brakes", 2, 0, 1],
      ["Mirrors", 1, 1, 0],
    ]);
    expect(total).toMatchObject({ category: "All categories", inspected: 3, falsePass: 1, unassessed: 1 });
    expect(total.falsePassRate).toBeCloseTo(1 / 3);
  });

  it("automated pass needs LIVE routing, no hard failure, no failed rule and no admin-review flag", () => {
    const pass = { routingDecision: "LIVE", hadHardFailure: false, reasons: [], checkResults: { needsAdminReview: false } };
    expect(isAutomatedPass(pass)).toBe(true);
    expect(isAutomatedPass({ ...pass, checkResults: { needsAdminReview: true } })).toBe(false);
    expect(isAutomatedPass({ ...pass, reasons: [{ code: "PRICE_OUTLIER" }] })).toBe(false);
    expect(isAutomatedPass({ ...pass, hadHardFailure: true })).toBe(false);
    expect(isAutomatedPass({ ...pass, routingDecision: "CHANGES_REQUESTED" })).toBe(false);
  });
});

describe("training-data export: column contract and CSV encoding", () => {
  it("has exactly these columns, in this order", () => {
    expect([...EXPORT_COLUMNS]).toEqual([
      "listing_id", "listing_status", "listing_created_at", "category_slug", "category_name", "part_number_id", "part_number_entered", "condition_grade", "condition_score", "price_paise", "trust_label", "inspection_requirement",
      "photo_count", "photo_storage_keys", "photo_shot_types", "photo_widths", "photo_heights", "photo_blur_scores", "photo_brightness_scores", "photo_phashes",
      "risk_assessment_id", "risk_assessed_at", "risk_score", "risk_reasons", "risk_routing", "risk_hard_failure", "risk_rule_set_version", "risk_vision_model_version", "risk_needs_admin_review",
      "inspection_id", "inspection_reason", "inspection_outcome", "inspection_completed_at", "inspection_notes",
      "order_id", "order_state", "order_outcome", "dispute_reason",
      "fitment_count", "fitment_variant_ids", "fitment_confirmation_count", "fitment_flagged_count",
      "is_sample",
    ]);
  });
  it("quotes commas, quotes and newlines; nulls are empty; formula-like values are neutralised", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10-01T00:00:00.000Z");
    expect(csvLine([1, null, "x"])).toBe("1,,x\r\n");
  });
});

describe("admin-only access (actions and the CSV route)", () => {
  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  it("members and mechanics are refused; admins pass", async () => {
    const { moderateReport } = await import("../../app/admin/reports/actions");
    const { changeUserRole, changeUserStatus } = await import("../../app/admin/users/actions");
    const { GET } = await import("../../app/api/admin/export/training.csv/route");
    for (const user of [null, { id: "m", roles: ["MEMBER"] }, { id: "k", roles: ["MEMBER", "MECHANIC"] }]) {
      currentUser.mockResolvedValue(user);
      expect((await moderateReport(null, fd({ reportId: "r1", decision: "DISMISSED" })))?.ok).toBe(false);
      expect((await changeUserRole(null, fd({ userId: "u1", role: "ADMIN", grant: "true" })))?.ok).toBe(false);
      expect((await changeUserStatus(null, fd({ userId: "u1", status: "SUSPENDED", reason: "Abuse reports" })))?.ok).toBe(false);
      expect((await GET(new Request("http://x/api/admin/export/training.csv"))).status).toBe(user ? 403 : 401);
    }
    expect(svc.moderateReport).not.toHaveBeenCalled();
    expect(svc.changeRole).not.toHaveBeenCalled();
    expect(svc.changeStatus).not.toHaveBeenCalled();
    expect(svc.auditExport).not.toHaveBeenCalled();
    currentUser.mockResolvedValue({ id: "a", roles: ["MEMBER", "ADMIN"] });
    expect((await moderateReport(null, fd({ reportId: "r1", decision: "DISMISSED" })))?.ok).toBe(true);
    const res = await GET(new Request("http://x/api/admin/export/training.csv?includeSample=true"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(svc.auditExport).toHaveBeenCalledWith(expect.objectContaining({ userId: "a" }), true);
    currentUser.mockReset();
  }, 60_000);
});
