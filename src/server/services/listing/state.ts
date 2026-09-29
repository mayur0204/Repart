import "server-only";
import type { ActorType, ListingStatus, Prisma } from "@/generated/prisma/client";
import { UserError } from "../../http/errors";
import { recordAudit } from "../audit/audit";
import { enqueueOutbox } from "../outbox/outbox";

/**
 * The only writer of Listing.status (PLAN.md §1.2 "State changes", §5.1).
 * M4 implements the seller events L1 submit, L2 resubmit and L15 withdraw; screening,
 * reservation and admin events arrive with M5 and later. Each transition runs in the caller's
 * transaction with optimistic locking, and writes a ListingEvent, an AuditLog row and any outbox jobs.
 */
export type ListingEventName = "submit" | "resubmit" | "withdraw";

const TRANSITIONS: Record<ListingEventName, { from: ListingStatus[]; to: ListingStatus }> = {
  submit: { from: ["DRAFT"], to: "SUBMITTED" }, // L1
  resubmit: { from: ["CHANGES_REQUESTED"], to: "SUBMITTED" }, // L2
  withdraw: { from: ["DRAFT", "CHANGES_REQUESTED", "LIVE"], to: "WITHDRAWN" }, // L15
};

export function canTransition(status: ListingStatus, event: ListingEventName): boolean {
  return TRANSITIONS[event].from.includes(status);
}

export async function transitionListing(
  tx: Prisma.TransactionClient,
  input: { listingId: string; event: ListingEventName; actor: { type: ActorType; id: string | null }; requestId?: string; payload?: Prisma.InputJsonValue },
): Promise<{ from: ListingStatus; to: ListingStatus }> {
  const rule = TRANSITIONS[input.event];
  const listing = await tx.listing.findUnique({ where: { id: input.listingId }, select: { status: true, version: true } });
  if (!listing) throw new UserError("That listing doesn't exist.");
  if (!rule.from.includes(listing.status)) {
    throw new UserError(`A listing that is ${listing.status.toLowerCase().replace(/_/g, " ")} can't be ${input.event === "withdraw" ? "withdrawn" : "submitted"}.`);
  }
  const now = new Date();
  const { count } = await tx.listing.updateMany({
    where: { id: input.listingId, status: listing.status, version: listing.version },
    data: { status: rule.to, version: { increment: 1 }, ...(rule.to === "SUBMITTED" ? { submittedAt: now } : {}) },
  });
  if (count === 0) throw new UserError("This listing was changed at the same time somewhere else. Reload the page and try again.");

  await tx.listingEvent.create({
    data: { listingId: input.listingId, fromStatus: listing.status, toStatus: rule.to, event: input.event, actorType: input.actor.type, actorId: input.actor.id, payload: input.payload },
  });
  await recordAudit(tx, {
    actor: input.actor,
    action: `listing.${input.event === "withdraw" ? "withdrawn" : "submitted"}`,
    entity: { type: "Listing", id: input.listingId },
    before: { status: listing.status },
    after: { status: rule.to },
    requestId: input.requestId,
  });
  if (rule.to === "SUBMITTED") {
    // The risk pipeline (M5) consumes this; until then the job is acknowledged and the listing stays SUBMITTED.
    await enqueueOutbox(tx, { queue: "risk", name: "check", payload: { listingId: input.listingId } });
  }
  return { from: listing.status, to: rule.to };
}
