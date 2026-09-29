import type { InterchangeSource, InterchangeType, ReviewStatus } from "@/generated/prisma/enums";

/**
 * Interchange rules (REPART_BRIEF.md §8, PLAN.md §6.6), as pure functions over links.
 *
 *  - A group is the connected component over APPROVED EXACT_EQUIVALENT and SUPERSEDED_BY links.
 *  - A link touching a safety-critical part counts only if its source is OEM_CATALOGUE or MECHANIC_CONFIRMED.
 *  - FITS_WITH_MODIFICATION links are one hop from the searched number only, never expanded,
 *    and never used to reach further group members.
 *  - Traversal is breadth-first with a visited set (cycle-safe) and a depth limit of 10.
 *  - SUPERSEDED_BY reads "A is replaced by B".
 */
export type GraphLink = {
  id: string;
  a: string;
  b: string;
  type: InterchangeType;
  source: InterchangeSource;
  status: ReviewStatus;
  notes: string | null;
};

export type GraphNode = { id: string; safetyCritical: boolean };

export const MAX_DEPTH = 10;
export const TRUSTED_SOURCES: ReadonlySet<InterchangeSource> = new Set(["OEM_CATALOGUE", "MECHANIC_CONFIRMED"]);
const GROUP_TYPES: ReadonlySet<InterchangeType> = new Set(["EXACT_EQUIVALENT", "SUPERSEDED_BY"]);

export type MatchKind = "SAME" | "EQUIVALENT" | "NEWER" | "OLDER" | "MODIFICATION";

export type Match = {
  partNumberId: string;
  kind: MatchKind;
  /** Source of the link that reached this part (absent for SAME). */
  source?: InterchangeSource;
  notes?: string;
  depth: number;
  /** Link ids on the path from the searched number (used later for fitment learning). */
  path: string[];
};

export type InterchangeResult = {
  group: Match[]; // includes the searched number itself as SAME
  modifications: Match[];
  /** Group members that are not replaced by any other group member (the current numbers). */
  current: string[];
};

/** Whether a link may be used at all: approved, and trusted if it touches a safety-critical part. */
export function linkCounts(link: GraphLink, nodes: ReadonlyMap<string, GraphNode>): boolean {
  if (link.status !== "APPROVED") return false;
  const critical = nodes.get(link.a)?.safetyCritical || nodes.get(link.b)?.safetyCritical;
  return !critical || TRUSTED_SOURCES.has(link.source);
}

type Step = "forward" | "backward" | "neutral";

function kindOf(steps: Step[]): MatchKind {
  const hasForward = steps.includes("forward");
  const hasBackward = steps.includes("backward");
  if (hasForward && !hasBackward) return "NEWER";
  if (hasBackward && !hasForward) return "OLDER";
  return "EQUIVALENT";
}

export function resolveInterchange(startId: string, links: readonly GraphLink[], nodes: ReadonlyMap<string, GraphNode>): InterchangeResult {
  const usable = links.filter((l) => l.a !== l.b && linkCounts(l, nodes));
  const groupLinks = usable.filter((l) => GROUP_TYPES.has(l.type));

  const adjacency = new Map<string, GraphLink[]>();
  for (const l of groupLinks) {
    for (const end of [l.a, l.b]) adjacency.set(end, [...(adjacency.get(end) ?? []), l]);
  }

  const seen = new Map<string, { steps: Step[]; path: string[]; source?: InterchangeSource }>([[startId, { steps: [], path: [] }]]);
  let frontier = [startId];
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const from = seen.get(id)!;
      // Deterministic order: by link id.
      for (const l of [...(adjacency.get(id) ?? [])].sort((x, y) => x.id.localeCompare(y.id))) {
        const other = l.a === id ? l.b : l.a;
        if (seen.has(other)) continue;
        const step: Step = l.type === "SUPERSEDED_BY" ? (l.a === id ? "forward" : "backward") : "neutral";
        seen.set(other, { steps: [...from.steps, step], path: [...from.path, l.id], source: l.source });
        next.push(other);
      }
    }
    frontier = next;
  }

  const group: Match[] = [...seen.entries()].map(([partNumberId, s]) => ({
    partNumberId,
    kind: partNumberId === startId ? "SAME" : kindOf(s.steps),
    source: s.source,
    depth: s.path.length,
    path: s.path,
  }));

  const modifications: Match[] = usable
    .filter((l) => l.type === "FITS_WITH_MODIFICATION" && (l.a === startId || l.b === startId))
    .map((l) => ({ l, other: l.a === startId ? l.b : l.a }))
    .filter(({ other }) => !seen.has(other))
    .sort((x, y) => x.l.id.localeCompare(y.l.id))
    .map(({ l, other }) => ({ partNumberId: other, kind: "MODIFICATION" as const, source: l.source, notes: l.notes ?? "", depth: 1, path: [l.id] }));

  const replaced = new Set(groupLinks.filter((l) => l.type === "SUPERSEDED_BY" && seen.has(l.a) && seen.has(l.b)).map((l) => l.a));
  const current = [...seen.keys()].filter((id) => !replaced.has(id));

  return { group, modifications, current };
}

/**
 * True if adding "a is replaced by b" would close a supersession loop, i.e. b already leads to a
 * through SUPERSEDED_BY links (approved or pending).
 */
export function wouldCreateSupersessionCycle(a: string, b: string, links: readonly Pick<GraphLink, "a" | "b" | "type" | "status">[]): boolean {
  if (a === b) return true;
  const forward = new Map<string, string[]>();
  for (const l of links) {
    if (l.type !== "SUPERSEDED_BY" || l.status === "REJECTED") continue;
    forward.set(l.a, [...(forward.get(l.a) ?? []), l.b]);
  }
  const stack = [b];
  const visited = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === a) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...(forward.get(id) ?? []));
  }
  return false;
}

/** Plain-language label for a match (PLAN.md §6.6 "Match labels"). */
export function matchLabel(m: Pick<Match, "kind" | "source" | "notes">): string {
  const src = m.source ? SOURCE_LABELS[m.source] : "";
  switch (m.kind) {
    case "SAME":
      return "Same part number";
    case "EQUIVALENT":
      return `Equivalent (${src})`;
    case "NEWER":
      return `Replaced by newer number (${src})`;
    case "OLDER":
      return `Older number, replaced by this one (${src})`;
    case "MODIFICATION":
      return `Fits with modification: ${m.notes ?? ""}`;
  }
}

export const SOURCE_LABELS: Record<InterchangeSource, string> = {
  OEM_CATALOGUE: "manufacturer catalogue",
  BRAND_CROSS_REFERENCE: "brand cross-reference",
  MECHANIC_CONFIRMED: "confirmed by a mechanic",
  ADMIN: "added by RePart",
  USER_SUBMITTED: "suggested by a user",
};

/** Symmetric link types are stored with the lower id first, so A–B and B–A can't both exist. */
export function canonicalPair(type: InterchangeType, a: string, b: string): [string, string] {
  if (type === "SUPERSEDED_BY") return [a, b];
  return a < b ? [a, b] : [b, a];
}
