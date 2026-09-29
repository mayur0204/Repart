import "server-only";
import { z } from "zod";
import type { InterchangeSource, InterchangeType, Prisma, PrismaClient } from "@/generated/prisma/client";
import { normalizePartNumber } from "@/lib/part-number";
import { slugify } from "@/lib/slug";
import { FieldError, NotFoundError, UserError } from "../../http/errors";
import { consumeRateLimit } from "../../http/rate-limit";
import { recordAudit } from "../audit/audit";
import { canonicalPair, MAX_DEPTH, resolveInterchange, wouldCreateSupersessionCycle, type GraphLink, type GraphNode, type InterchangeResult } from "./graph";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Actor = { userId: string; requestId?: string };

const toGraphLink = (l: { id: string; partNumberAId: string; partNumberBId: string; type: InterchangeType; source: InterchangeSource; status: GraphLink["status"]; notes: string | null }): GraphLink => ({
  id: l.id,
  a: l.partNumberAId,
  b: l.partNumberBId,
  type: l.type,
  source: l.source,
  status: l.status,
  notes: l.notes,
});

/**
 * Loads the candidate component around a part number with a recursive CTE over approved
 * EXACT_EQUIVALENT / SUPERSEDED_BY links (depth ≤ 10, no revisits along a path), plus the
 * start's direct links. The rules in graph.ts then decide what actually counts.
 */
export async function loadInterchange(db: Pick<Db, "$queryRaw" | "interchangeLink" | "partNumber">, startId: string): Promise<InterchangeResult> {
  const reach = await db.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE reach(id, depth, path) AS (
      SELECT ${startId}::text, 0, ARRAY[${startId}::text]
      UNION ALL
      SELECT n.other, r.depth + 1, r.path || n.other
      FROM reach r
      JOIN LATERAL (
        SELECT CASE WHEN l."partNumberAId" = r.id THEN l."partNumberBId" ELSE l."partNumberAId" END AS other
        FROM "InterchangeLink" l
        WHERE (l."partNumberAId" = r.id OR l."partNumberBId" = r.id)
          AND l.status = 'APPROVED'
          AND l.type IN ('EXACT_EQUIVALENT', 'SUPERSEDED_BY')
      ) n ON true
      WHERE r.depth < ${MAX_DEPTH} AND NOT n.other = ANY(r.path)
    )
    SELECT DISTINCT id FROM reach`;
  const ids = reach.map((r) => r.id);

  const links = await db.interchangeLink.findMany({
    where: { status: "APPROVED", OR: [{ partNumberAId: { in: ids } }, { partNumberBId: { in: ids } }] },
  });
  const endpointIds = [...new Set(links.flatMap((l) => [l.partNumberAId, l.partNumberBId]).concat(startId))];
  const parts = await db.partNumber.findMany({ where: { id: { in: endpointIds } }, select: { id: true, category: { select: { isSafetyCritical: true } } } });
  const nodes = new Map<string, GraphNode>(parts.map((p) => [p.id, { id: p.id, safetyCritical: p.category.isSafetyCritical }]));
  return resolveInterchange(startId, links.map(toGraphLink), nodes);
}

/** Finds a part number by the URL's brand slug and number (any spacing/dash/case). */
export async function findPartNumber(db: Pick<Db, "partNumber">, brandSlug: string, number: string) {
  const candidates = await db.partNumber.findMany({ where: { normalized: normalizePartNumber(number) } });
  return candidates.find((p) => slugify(p.brand) === brandSlug.toLowerCase()) ?? null;
}

const partSelect = { id: true, display: true, brand: true, isOem: true, category: { select: { name: true, slug: true, isSafetyCritical: true } } } as const;
const variantSelect = { id: true, name: true, yearFrom: true, yearTo: true, model: { select: { name: true, make: { select: { name: true } } } } } as const;

/** Everything the public part-number page shows. */
export async function getPartNumberPage(db: Db, brandSlug: string, number: string) {
  const part = await findPartNumber(db, brandSlug, number);
  if (!part) return null;
  const result = await loadInterchange(db, part.id);
  const memberIds = result.group.map((m) => m.partNumberId);
  const modIds = result.modifications.map((m) => m.partNumberId);

  const [details, fitments] = await Promise.all([
    db.partNumber.findMany({ where: { id: { in: [...memberIds, ...modIds] } }, select: partSelect }),
    db.fitment.findMany({
      where: { partNumberId: { in: [...memberIds, ...modIds] }, listingId: null },
      select: { partNumberId: true, verdict: true, source: true, notes: true, variant: { select: variantSelect } },
    }),
  ]);
  const byId = new Map(details.map((d) => [d.id, d]));
  const self = byId.get(part.id)!;

  const modNotes = new Map(result.modifications.map((m) => [m.partNumberId, m.notes ?? ""]));
  const vehicles = fitments.map((f) => ({
    ...f,
    viaModification: modNotes.has(f.partNumberId!) ? modNotes.get(f.partNumberId!)! : null,
    via: byId.get(f.partNumberId!)!,
  }));

  return {
    part: self,
    current: result.current.filter((id) => id !== part.id).map((id) => byId.get(id)!),
    isCurrent: result.current.includes(part.id),
    equivalents: result.group.filter((m) => m.kind !== "SAME").map((m) => ({ ...m, part: byId.get(m.partNumberId)! })),
    modifications: result.modifications.map((m) => ({ ...m, part: byId.get(m.partNumberId)! })),
    fits: vehicles.filter((v) => v.verdict === "FITS" && v.viaModification === null),
    fitsWithModification: vehicles.filter((v) => v.verdict === "FITS" && v.viaModification !== null),
    doesNotFit: vehicles.filter((v) => v.verdict === "DOES_NOT_FIT" && v.viaModification === null),
  };
}

// ───────────────────────────── links: create, suggest, review ─────────────────────────────

const linkTypes = ["EXACT_EQUIVALENT", "SUPERSEDED_BY", "FITS_WITH_MODIFICATION"] as const;

async function assertLinkAllowed(tx: Pick<Tx, "interchangeLink">, type: InterchangeType, a: string, b: string, notes: string | null, ignoreId?: string) {
  if (a === b) throw new FieldError({ other: "A part number can't be linked to itself." });
  if (type === "FITS_WITH_MODIFICATION" && !notes?.trim()) {
    throw new FieldError({ notes: "Describe the modification needed, for example 'Drill a 6 mm hole for the mounting bolt'." });
  }
  const existing = await tx.interchangeLink.findFirst({
    where: {
      id: ignoreId ? { not: ignoreId } : undefined,
      status: { not: "REJECTED" },
      OR: [
        { partNumberAId: a, partNumberBId: b },
        { partNumberAId: b, partNumberBId: a },
      ],
    },
  });
  if (existing) throw new UserError("These two part numbers are already linked or waiting for review.");
  if (type === "SUPERSEDED_BY") {
    const chain = await tx.interchangeLink.findMany({ where: { type: "SUPERSEDED_BY", status: { not: "REJECTED" } }, select: { partNumberAId: true, partNumberBId: true, type: true, status: true } });
    if (wouldCreateSupersessionCycle(a, b, chain.map((l) => ({ a: l.partNumberAId, b: l.partNumberBId, type: l.type, status: l.status })))) {
      throw new UserError("That would make a loop of replacements (a number replacing itself). Check the direction.");
    }
  }
}

export const suggestionInput = z.object({
  fromPartNumberId: z.string().min(1),
  brand: z.string().trim().min(1, "Enter the brand of the other part number.").max(60),
  number: z.string().trim().min(2, "Enter the other part number.").max(60),
  type: z.enum(linkTypes, { message: "Choose how the parts relate." }),
  notes: z.string().trim().max(500).optional().transform((v) => (v ? v : null)),
});

/**
 * "Suggest an equivalent part number": creates a PENDING, USER_SUBMITTED link for admin review.
 * The other number must already be in the catalogue. Rate limited per user.
 */
export async function suggestEquivalent(db: Db, actor: Actor, input: Record<string, unknown>) {
  const data = suggestionInput.parse(input);
  await consumeRateLimit(db, "interchangeSuggestionsPerUser", actor.userId);
  const from = await db.partNumber.findUnique({ where: { id: data.fromPartNumberId } });
  if (!from) throw new NotFoundError("part number");
  const candidates = await db.partNumber.findMany({ where: { normalized: normalizePartNumber(data.number) } });
  const other = candidates.find((p) => p.brand.toLowerCase() === data.brand.toLowerCase());
  if (!other) {
    throw new FieldError({ number: "We don't have that brand and number in our catalogue yet. Check the spelling, or mention it in the notes of another suggestion later." });
  }
  // "This number is replaced by <other>" is the natural reading from this page.
  const [a, b] = canonicalPair(data.type, from.id, other.id);
  return db.$transaction(async (tx) => {
    await assertLinkAllowed(tx, data.type, a, b, data.notes);
    const link = await tx.interchangeLink.create({
      data: { partNumberAId: a, partNumberBId: b, type: data.type, source: "USER_SUBMITTED", status: "PENDING", notes: data.notes, submittedById: actor.userId },
    });
    await recordAudit(tx, {
      actor: { type: "USER", id: actor.userId },
      action: "interchange.suggested",
      entity: { type: "InterchangeLink", id: link.id },
      after: { a, b, type: data.type },
      requestId: actor.requestId,
    });
    return link;
  });
}

export const adminLinkInput = z.object({
  aBrand: z.string().trim().min(1, "Enter the brand."),
  aNumber: z.string().trim().min(1, "Enter the part number."),
  bBrand: z.string().trim().min(1, "Enter the brand."),
  bNumber: z.string().trim().min(1, "Enter the part number."),
  type: z.enum(linkTypes),
  source: z.enum(["OEM_CATALOGUE", "BRAND_CROSS_REFERENCE", "MECHANIC_CONFIRMED", "ADMIN"]),
  notes: z.string().trim().max(500).optional().transform((v) => (v ? v : null)),
});

async function partByBrandNumber(db: Pick<Tx, "partNumber">, brand: string, number: string, field: string) {
  const found = (await db.partNumber.findMany({ where: { normalized: normalizePartNumber(number) } })).find((p) => p.brand.toLowerCase() === brand.toLowerCase());
  if (!found) throw new FieldError({ [field]: `No part number ${number} from ${brand} in the catalogue.` });
  return found;
}

/** Admin-created links are approved immediately. */
export async function createLink(db: Db, actor: Actor, input: Record<string, unknown>) {
  const data = adminLinkInput.parse(input);
  return db.$transaction(async (tx) => {
    const pa = await partByBrandNumber(tx, data.aBrand, data.aNumber, "aNumber");
    const pb = await partByBrandNumber(tx, data.bBrand, data.bNumber, "bNumber");
    const [a, b] = canonicalPair(data.type, pa.id, pb.id);
    await assertLinkAllowed(tx, data.type, a, b, data.notes);
    const link = await tx.interchangeLink.create({
      data: { partNumberAId: a, partNumberBId: b, type: data.type, source: data.source, status: "APPROVED", notes: data.notes, reviewedById: actor.userId, reviewedAt: new Date() },
    });
    await recordAudit(tx, { actor: { type: "ADMIN", id: actor.userId }, action: "interchange.created", entity: { type: "InterchangeLink", id: link.id }, after: { a, b, type: data.type, source: data.source }, requestId: actor.requestId });
    return link;
  });
}

const linkInclude = {
  partNumberA: { select: partSelect },
  partNumberB: { select: partSelect },
} as const;

/** Review queue: pending suggestions and approved links flagged by fitment learning. */
export function reviewQueue(db: Pick<Db, "interchangeLink">) {
  return db.interchangeLink.findMany({
    where: { OR: [{ status: "PENDING" }, { inReviewQueue: true }] },
    include: linkInclude,
    orderBy: [{ inReviewQueue: "desc" }, { createdAt: "asc" }],
    take: 200,
  });
}

export async function reviewLink(db: Db, actor: Actor, input: { id: string; decision: "APPROVE" | "REJECT" | "CLEAR_FLAG" }) {
  await db.$transaction(async (tx) => {
    const link = await tx.interchangeLink.findUnique({ where: { id: input.id } });
    if (!link) throw new NotFoundError("link");
    const before = { status: link.status, inReviewQueue: link.inReviewQueue };
    let data: Prisma.InterchangeLinkUpdateInput;
    if (input.decision === "APPROVE") {
      if (link.status === "APPROVED") throw new UserError("This link is already approved.");
      if (link.type === "SUPERSEDED_BY") {
        const chain = await tx.interchangeLink.findMany({ where: { type: "SUPERSEDED_BY", status: "APPROVED" } });
        if (wouldCreateSupersessionCycle(link.partNumberAId, link.partNumberBId, chain.map(toGraphLink))) {
          throw new UserError("Approving this would make a loop of replacements. Reject it or fix the direction.");
        }
      }
      data = { status: "APPROVED", inReviewQueue: false, reviewedById: actor.userId, reviewedAt: new Date() };
    } else if (input.decision === "REJECT") {
      data = { status: "REJECTED", inReviewQueue: false, reviewedById: actor.userId, reviewedAt: new Date() };
    } else {
      if (!link.inReviewQueue) throw new UserError("This link isn't flagged.");
      data = { inReviewQueue: false, reviewedById: actor.userId, reviewedAt: new Date() };
    }
    const updated = await tx.interchangeLink.update({ where: { id: link.id }, data });
    await recordAudit(tx, {
      actor: { type: "ADMIN", id: actor.userId },
      action: `interchange.${input.decision.toLowerCase()}`,
      entity: { type: "InterchangeLink", id: link.id },
      before,
      after: { status: updated.status, inReviewQueue: updated.inReviewQueue },
      requestId: actor.requestId,
    });
  });
}
