import "server-only";
import type { ActorType, ListingStatus, Prisma } from "@/generated/prisma/client";
import { UserError } from "../../http/errors";
import { recordAudit } from "../audit/audit";
import { enqueueOutbox } from "../outbox/outbox";

/**
 * The only writer of Listing.status (PLAN.md §1.2 "State changes", §5.1).
 * Implemented: L1 submit, L2 resubmit, L15 withdraw (M4); L3 screeningStarted, L4 screeningFailed,
 * L5 screeningPassed, L7 adminReject, L8 adminRequestChanges (M5); L10 reserve, L11 release, L13 sold,
 * L14 returnedAfterDispute (M8, driven by the order service only). The material-edit rule arrives later. Each transition runs in the caller's transaction
 * with optimistic locking and writes a ListingEvent, an AuditLog row and any outbox jobs.
 */
export type ListingEventName =
  | "submit" | "resubmit" | "withdraw" | "screeningStarted" | "screeningFailed" | "screeningPassed" | "adminReject" | "adminRequestChanges"
  | "reserve" | "release" | "sold" | "returnedAfterDispute";

const TRANSITIONS: Record<ListingEventName, { from: ListingStatus[]; to: ListingStatus; audit: string }> = {
  submit: { from: ["DRAFT"], to: "SUBMITTED", audit: "listing.submitted" }, // L1
  resubmit: { from: ["CHANGES_REQUESTED"], to: "SUBMITTED", audit: "listing.submitted" }, // L2
  screeningStarted: { from: ["SUBMITTED"], to: "SCREENING", audit: "listing.screening_started" }, // L3
  screeningFailed: { from: ["SCREENING"], to: "CHANGES_REQUESTED", audit: "listing.changes_requested" }, // L4
  screeningPassed: { from: ["SCREENING"], to: "LIVE", audit: "listing.live" }, // L5
  adminReject: { from: ["LIVE", "CHANGES_REQUESTED"], to: "REJECTED", audit: "listing.rejected_by_admin" }, // L7
  adminRequestChanges: { from: ["LIVE"], to: "CHANGES_REQUESTED", audit: "listing.changes_requested_by_admin" }, // L8
  withdraw: { from: ["DRAFT", "CHANGES_REQUESTED", "LIVE"], to: "WITHDRAWN", audit: "listing.withdrawn" }, // L15
  reserve: { from: ["LIVE"], to: "RESERVED", audit: "listing.reserved" }, // L10
  release: { from: ["RESERVED"], to: "LIVE", audit: "listing.released" }, // L11
  sold: { from: ["RESERVED"], to: "SOLD", audit: "listing.sold" }, // L13
  returnedAfterDispute: { from: ["RESERVED"], to: "WITHDRAWN", audit: "listing.returned_after_dispute" }, // L14
};

export function canTransition(status: ListingStatus, event: ListingEventName): boolean {
  return TRANSITIONS[event].from.includes(status);
}

const VERB: Partial<Record<ListingEventName, string>> = { withdraw: "withdrawn", adminReject: "rejected", adminRequestChanges: "sent back for changes", reserve: "bought", release: "released", sold: "sold", returnedAfterDispute: "withdrawn" };

export async function transitionListing(
  tx: Prisma.TransactionClient,
  input: {
    listingId: string;
    event: ListingEventName;
    actor: { type: ActorType; id: string | null };
    requestId?: string;
    payload?: Prisma.InputJsonValue;
    /** Extra listing fields written in the same update (e.g. sellerMessage). */
    data?: Prisma.ListingUpdateManyMutationInput;
  },
): Promise<{ from: ListingStatus; to: ListingStatus }> {
  const rule = TRANSITIONS[input.event];
  const listing = await tx.listing.findUnique({ where: { id: input.listingId }, select: { status: true, version: true } });
  if (!listing) throw new UserError("That listing doesn't exist.");
  if (!rule.from.includes(listing.status)) {
    throw new UserError(`A listing that is ${listing.status.toLowerCase().replace(/_/g, " ")} can't be ${VERB[input.event] ?? "submitted"}.`);
  }
  const now = new Date();
  const { count } = await tx.listing.updateMany({
    where: { id: input.listingId, status: listing.status, version: listing.version },
    data: {
      ...input.data,
      status: rule.to,
      version: { increment: 1 },
      ...(rule.to === "SUBMITTED" ? { submittedAt: now } : {}),
      ...(input.event === "screeningPassed" ? { liveAt: now } : {}),
      ...(rule.to === "SOLD" ? { soldAt: now } : {}),
    },
  });
  if (count === 0) throw new UserError("This listing was changed at the same time somewhere else. Reload the page and try again.");

  await tx.listingEvent.create({
    data: { listingId: input.listingId, fromStatus: listing.status, toStatus: rule.to, event: input.event, actorType: input.actor.type, actorId: input.actor.id, payload: input.payload },
  });
  await recordAudit(tx, {
    actor: input.actor,
    action: rule.audit,
    entity: { type: "Listing", id: input.listingId },
    before: { status: listing.status },
    after: { status: rule.to, ...(input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? input.payload : {}) },
    requestId: input.requestId,
  });
  if (rule.to === "SUBMITTED") {
    await enqueueOutbox(tx, { queue: "risk", name: "check", payload: { listingId: input.listingId } });
  }
  return { from: listing.status, to: rule.to };
}
