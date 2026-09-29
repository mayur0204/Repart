import { describe, expect, it } from "vitest";
import {
  canonicalPair,
  linkCounts,
  matchLabel,
  MAX_DEPTH,
  resolveInterchange,
  wouldCreateSupersessionCycle,
  type GraphLink,
  type GraphNode,
} from "@/server/services/interchange/graph";

let seq = 0;
const link = (a: string, b: string, over: Partial<GraphLink> = {}): GraphLink => ({
  id: `l${String(++seq).padStart(3, "0")}`,
  a,
  b,
  type: "EXACT_EQUIVALENT",
  source: "OEM_CATALOGUE",
  status: "APPROVED",
  notes: null,
  ...over,
});
const nodes = (ids: string[], critical: string[] = []) => new Map<string, GraphNode>(ids.map((id) => [id, { id, safetyCritical: critical.includes(id) }]));
const ids = (r: ReturnType<typeof resolveInterchange>) => r.group.map((m) => m.partNumberId).sort();
const kinds = (r: ReturnType<typeof resolveInterchange>) => Object.fromEntries(r.group.map((m) => [m.partNumberId, m.kind]));

describe("interchange groups", () => {
  it("connects exact equivalents and supersessions transitively", () => {
    const r = resolveInterchange("A", [link("A", "B"), link("B", "C", { type: "SUPERSEDED_BY" }), link("D", "C")], nodes(["A", "B", "C", "D"]));
    expect(ids(r)).toEqual(["A", "B", "C", "D"]);
    expect(kinds(r)).toMatchObject({ A: "SAME", B: "EQUIVALENT", C: "NEWER", D: "NEWER" });
  });

  it("ignores pending and rejected links", () => {
    const r = resolveInterchange("A", [link("A", "B", { status: "PENDING" }), link("A", "C", { status: "REJECTED" })], nodes(["A", "B", "C"]));
    expect(ids(r)).toEqual(["A"]);
  });

  it("is cycle-safe: a loop of equivalents visits each part once", () => {
    const r = resolveInterchange("A", [link("A", "B"), link("B", "C"), link("C", "A"), link("C", "C")], nodes(["A", "B", "C"]));
    expect(ids(r)).toEqual(["A", "B", "C"]);
    expect(r.group.find((m) => m.partNumberId === "C")?.depth).toBe(1);
  });

  it("stops at the depth limit", () => {
    const chain = Array.from({ length: MAX_DEPTH + 3 }, (_, i) => `P${i}`);
    const links = chain.slice(1).map((id, i) => link(chain[i]!, id));
    const r = resolveInterchange("P0", links, nodes(chain));
    expect(r.group).toHaveLength(MAX_DEPTH + 1);
    expect(Math.max(...r.group.map((m) => m.depth))).toBe(MAX_DEPTH);
  });

  it("records the path of link ids to each member", () => {
    const ab = link("A", "B");
    const bc = link("B", "C");
    const r = resolveInterchange("A", [ab, bc], nodes(["A", "B", "C"]));
    expect(r.group.find((m) => m.partNumberId === "C")?.path).toEqual([ab.id, bc.id]);
  });
});

describe("supersession chains", () => {
  const chain = [link("OLD", "MID", { type: "SUPERSEDED_BY" }), link("MID", "NEW", { type: "SUPERSEDED_BY" })];

  it("labels newer and older numbers from the searched number's point of view", () => {
    expect(kinds(resolveInterchange("OLD", chain, nodes(["OLD", "MID", "NEW"])))).toEqual({ OLD: "SAME", MID: "NEWER", NEW: "NEWER" });
    expect(kinds(resolveInterchange("NEW", chain, nodes(["OLD", "MID", "NEW"])))).toEqual({ NEW: "SAME", MID: "OLDER", OLD: "OLDER" });
    expect(kinds(resolveInterchange("MID", chain, nodes(["OLD", "MID", "NEW"])))).toEqual({ MID: "SAME", OLD: "OLDER", NEW: "NEWER" });
  });

  it("identifies the current (not replaced) numbers", () => {
    expect(resolveInterchange("OLD", chain, nodes(["OLD", "MID", "NEW"])).current).toEqual(["NEW"]);
  });

  it("a mixed path (older then newer) is just an equivalent", () => {
    const r = resolveInterchange("X", [link("X", "Y", { type: "SUPERSEDED_BY" }), link("Z", "Y", { type: "SUPERSEDED_BY" })], nodes(["X", "Y", "Z"]));
    expect(kinds(r).Z).toBe("EQUIVALENT");
    expect(r.current).toEqual(["Y"]);
  });

  it("detects loops before they are created", () => {
    const existing = chain.map((l) => ({ ...l }));
    expect(wouldCreateSupersessionCycle("NEW", "OLD", existing)).toBe(true);
    expect(wouldCreateSupersessionCycle("OLD", "OLD", existing)).toBe(true);
    expect(wouldCreateSupersessionCycle("NEW", "NEWER", existing)).toBe(false);
    // Rejected links don't count; pending ones do.
    expect(wouldCreateSupersessionCycle("NEW", "OLD", existing.map((l) => ({ ...l, status: "REJECTED" as const })))).toBe(false);
    expect(wouldCreateSupersessionCycle("NEW", "OLD", existing.map((l) => ({ ...l, status: "PENDING" as const })))).toBe(true);
  });
});

describe("safety-critical filtering", () => {
  it("only manufacturer-catalogue and mechanic-confirmed links count when a critical part is involved", () => {
    const links = [
      link("A", "B", { source: "BRAND_CROSS_REFERENCE" }),
      link("A", "C", { source: "OEM_CATALOGUE" }),
      link("A", "D", { source: "MECHANIC_CONFIRMED" }),
      link("A", "E", { source: "ADMIN" }),
      link("A", "F", { source: "USER_SUBMITTED" }),
    ];
    expect(ids(resolveInterchange("A", links, nodes(["A", "B", "C", "D", "E", "F"], ["A"])))).toEqual(["A", "C", "D"]);
    expect(ids(resolveInterchange("A", links, nodes(["A", "B", "C", "D", "E", "F"])))).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("an untrusted link into a critical part can't bridge two groups", () => {
    const links = [link("A", "B", { source: "BRAND_CROSS_REFERENCE" }), link("B", "C")];
    expect(ids(resolveInterchange("A", links, nodes(["A", "B", "C"], ["B"])))).toEqual(["A"]);
  });

  it("linkCounts requires approval", () => {
    expect(linkCounts(link("A", "B", { status: "PENDING" }), nodes(["A", "B"]))).toBe(false);
  });
});

describe("fits-with-modification", () => {
  const mod = (a: string, b: string, notes = "Drill a 6 mm hole") => link(a, b, { type: "FITS_WITH_MODIFICATION", notes });

  it("is one hop from the searched number, with notes, and not part of the group", () => {
    const r = resolveInterchange("A", [link("A", "B"), mod("A", "M")], nodes(["A", "B", "M"]));
    expect(ids(r)).toEqual(["A", "B"]);
    expect(r.modifications).toEqual([expect.objectContaining({ partNumberId: "M", kind: "MODIFICATION", notes: "Drill a 6 mm hole", depth: 1 })]);
  });

  it("is never expanded: the modified part's equivalents and further modifications are not included", () => {
    const r = resolveInterchange("A", [mod("A", "M"), link("M", "M2"), mod("M", "M3")], nodes(["A", "M", "M2", "M3"]));
    expect(r.modifications.map((m) => m.partNumberId)).toEqual(["M"]);
    expect(ids(r)).toEqual(["A"]);
  });

  it("modifications of other group members are not the searched number's modifications", () => {
    const r = resolveInterchange("A", [link("A", "B"), mod("B", "M")], nodes(["A", "B", "M"]));
    expect(r.modifications).toEqual([]);
  });

  it("a part that is both an equivalent and a modification is reported only as an equivalent", () => {
    const r = resolveInterchange("A", [link("A", "B"), mod("A", "B")], nodes(["A", "B"]));
    expect(r.modifications).toEqual([]);
    expect(kinds(r).B).toBe("EQUIVALENT");
  });

  it("follows the safety rules too", () => {
    const r = resolveInterchange("A", [link("A", "M", { type: "FITS_WITH_MODIFICATION", notes: "x", source: "BRAND_CROSS_REFERENCE" })], nodes(["A", "M"], ["A"]));
    expect(r.modifications).toEqual([]);
  });
});

describe("labels and canonical pairs", () => {
  it("uses the plan's wording", () => {
    expect(matchLabel({ kind: "SAME" })).toBe("Same part number");
    expect(matchLabel({ kind: "EQUIVALENT", source: "MECHANIC_CONFIRMED" })).toBe("Equivalent (confirmed by a mechanic)");
    expect(matchLabel({ kind: "NEWER", source: "OEM_CATALOGUE" })).toBe("Replaced by newer number (manufacturer catalogue)");
    expect(matchLabel({ kind: "MODIFICATION", notes: "Drill a hole" })).toBe("Fits with modification: Drill a hole");
  });

  it("orders symmetric pairs but keeps supersession direction", () => {
    expect(canonicalPair("EXACT_EQUIVALENT", "b", "a")).toEqual(["a", "b"]);
    expect(canonicalPair("FITS_WITH_MODIFICATION", "b", "a")).toEqual(["a", "b"]);
    expect(canonicalPair("SUPERSEDED_BY", "b", "a")).toEqual(["b", "a"]);
  });
});
