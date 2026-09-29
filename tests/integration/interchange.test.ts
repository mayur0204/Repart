import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { FieldError, UserError } from "../../src/server/http/errors";
import { useRateLimitStore } from "../../src/server/http/rate-limit";
import { getPartNumberPage, loadInterchange, reviewLink, reviewQueue, suggestEquivalent } from "../../src/server/services/interchange/interchange";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const admin = { userId: "sample-user-admin" };
const buyer = { userId: "sample-user-buyer" };

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
beforeEach(() => useRateLimitStore("memory"));
afterAll(async () => {
  useRateLimitStore("redis");
  await db.interchangeLink.deleteMany({ where: { isSample: false } }); // links created by these tests
  await seed(db); // restore the flag cleared in the last test
  await db.$disconnect();
});

const kinds = (r: Awaited<ReturnType<typeof loadInterchange>>) => Object.fromEntries(r.group.map((m) => [m.partNumberId, m.kind]));

describe("interchange over the SAMPLE catalogue (Postgres recursive CTE + rules)", () => {
  it("safety-critical brake pads: brand cross-reference excluded, OEM supersession and mechanic-confirmed link included", async () => {
    const r = await loadInterchange(db, "sample-pn-brk-0001");
    expect(kinds(r)).toEqual({ "sample-pn-brk-0001": "SAME", "sample-pn-brk-0003": "NEWER", "sample-pn-brk-0004": "NEWER" });
    expect(r.current.sort()).toEqual(["sample-pn-brk-0003", "sample-pn-brk-0004"]);
  });

  it("mirrors (not safety-critical): brand cross-reference counts; modification is one hop with notes; rejected link ignored", async () => {
    const r = await loadInterchange(db, "sample-pn-mir-0001");
    expect(kinds(r)).toEqual({ "sample-pn-mir-0001": "SAME", "sample-pn-mir-0002": "EQUIVALENT" });
    expect(r.modifications).toEqual([expect.objectContaining({ partNumberId: "sample-pn-mir-0003", notes: expect.stringMatching(/mounting stem/) })]);
    // From mir-0002 the modification is not inherited (not transitive), and the rejected 2–3 link doesn't count.
    const from2 = await loadInterchange(db, "sample-pn-mir-0002");
    expect(from2.modifications).toEqual([]);
    expect(Object.keys(kinds(from2)).sort()).toEqual(["sample-pn-mir-0001", "sample-pn-mir-0002"]);
  });

  it("pending suggestions don't count until approved", async () => {
    expect((await loadInterchange(db, "sample-pn-lgt-0001")).group).toHaveLength(1);
  });

  it("part-number page: found by brand slug and a messy number; vehicles come from the whole group", async () => {
    const page = await getPartNumberPage(db, "sample-motors", "sample brk 0001");
    expect(page?.part.display).toBe("SAMPLE-BRK-0001");
    expect(page?.isCurrent).toBe(false);
    expect(page?.current.map((c) => c.display).sort()).toEqual(["SAMPLE-BRK 0004", "SAMPLE-BRK-0003"]);
    const variants = new Set(page?.fits.map((f) => f.variant.id));
    expect(variants).toEqual(new Set(["sample-variant-street-150-std", "sample-variant-street-150-disc", "sample-variant-roadster-200-std"]));
    expect(await getPartNumberPage(db, "wrong-brand", "SAMPLE-BRK-0001")).toBeNull();
  });

  it("part-number page: fitments of a modification part are shown separately with the notes", async () => {
    const page = await getPartNumberPage(db, "sample-motors", "SAMPLE-MIR-0001");
    expect(page?.modifications[0]?.part.display).toBe("SAMPLE-MIR-0003");
    expect(page?.fitsWithModification.every((f) => f.viaModification?.includes("mounting stem"))).toBe(true);
  });
});

describe("suggestions and review", () => {
  it("a member suggestion is PENDING in the queue; approval adds it to the group; the audit log records both", async () => {
    const link = await suggestEquivalent(db, buyer, { fromPartNumberId: "sample-pn-exh-0001", brand: "sample motors", number: "SAMPLE SET 0001", type: "EXACT_EQUIVALENT" });
    expect(link).toMatchObject({ status: "PENDING", source: "USER_SUBMITTED", submittedById: buyer.userId });
    expect((await reviewQueue(db)).some((l) => l.id === link.id)).toBe(true);
    expect((await loadInterchange(db, "sample-pn-exh-0001")).group).toHaveLength(1);

    await reviewLink(db, admin, { id: link.id, decision: "APPROVE" });
    expect(Object.keys(kinds(await loadInterchange(db, "sample-pn-exh-0001"))).sort()).toEqual(["sample-pn-exh-0001", "sample-pn-set-0001"]);
    expect((await db.auditLog.findMany({ where: { entityId: link.id } })).map((a) => a.action).sort()).toEqual(["interchange.approve", "interchange.suggested"]);
  });

  it("refuses unknown numbers, self-links, duplicates and modifications without notes", async () => {
    const base = { fromPartNumberId: "sample-pn-whl-0001", brand: "Sample Motors", type: "EXACT_EQUIVALENT" };
    await expect(suggestEquivalent(db, buyer, { ...base, number: "NOT-IN-CATALOGUE" })).rejects.toBeInstanceOf(FieldError);
    await expect(suggestEquivalent(db, buyer, { ...base, number: "SAMPLE-WHL-0001" })).rejects.toThrow(/itself/);
    await expect(suggestEquivalent(db, buyer, { ...base, fromPartNumberId: "sample-pn-mir-0002", brand: "Sample Motors", number: "SAMPLE-MIR-0001" })).rejects.toBeInstanceOf(UserError);
    await expect(suggestEquivalent(db, buyer, { ...base, number: "SAMPLE-LGT-0001", type: "FITS_WITH_MODIFICATION" })).rejects.toThrow(/Describe the modification/);
  });

  it("is rate limited per user from the settings limit", async () => {
    const user = await db.user.create({ data: { phone: `+917${Date.now().toString().slice(-9)}` } });
    const attempt = () => suggestEquivalent(db, { userId: user.id }, { fromPartNumberId: "sample-pn-whl-0001", brand: "x", number: "nope", type: "EXACT_EQUIVALENT" }).catch((e) => e);
    for (let i = 0; i < 10; i++) expect(await attempt()).toBeInstanceOf(FieldError);
    expect((await attempt()).message).toMatch(/Too many attempts/);
  });

  it("approving a supersession that would close a loop is refused", async () => {
    // brk-0001 → brk-0003 exists (OEM). A pending 0003 → 0001 would loop.
    const loop = await db.interchangeLink.create({
      data: { partNumberAId: "sample-pn-brk-0003", partNumberBId: "sample-pn-brk-0001", type: "SUPERSEDED_BY", source: "USER_SUBMITTED", status: "PENDING" },
    });
    await expect(reviewLink(db, admin, { id: loop.id, decision: "APPROVE" })).rejects.toThrow(/loop/);
    await reviewLink(db, admin, { id: loop.id, decision: "REJECT" });
    expect((await db.interchangeLink.findUniqueOrThrow({ where: { id: loop.id } })).status).toBe("REJECTED");
  });

  it("flagged links can be kept (flag cleared) by an admin", async () => {
    await db.interchangeLink.update({ where: { id: "sample-link-mir-1-2" }, data: { inReviewQueue: true, flaggedCount: 1 } });
    await reviewLink(db, admin, { id: "sample-link-mir-1-2", decision: "CLEAR_FLAG" });
    expect((await db.interchangeLink.findUniqueOrThrow({ where: { id: "sample-link-mir-1-2" } })).inReviewQueue).toBe(false);
  });
});
