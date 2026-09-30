import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { maskContactDetails } from "@/lib/listing";
import type { StorageProvider } from "../../adapters/storage/types";
import { FieldError, NotFoundError, UserError } from "../../http/errors";
import { consumeRateLimit } from "../../http/rate-limit";
import { enqueueOutbox } from "../outbox/outbox";

/**
 * Messages (REPART_BRIEF.md §9 "Messages", PLAN.md §4.6, M7): one thread per listing per buyer,
 * the listing pinned on top, contact details masked on the server before storage, rate-limited sends,
 * report a message, and an in-app notification for the other participant.
 * Every read and write checks that the caller is the buyer or the seller of the conversation.
 */
type Db = PrismaClient;
type Actor = { userId: string; requestId?: string };
type Deps = { storage: StorageProvider; bucket: string };

export const MAX_MESSAGE_LENGTH = 2000;
const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] ?? "RePart member";

/** The conversation if the user takes part in it; otherwise NotFound (never reveals that it exists). */
async function participantConversation(db: Pick<Db, "conversation">, userId: string, conversationId: string) {
  const c = await db.conversation.findFirst({ where: { id: conversationId, OR: [{ buyerId: userId }, { sellerId: userId }] } });
  if (!c) throw new NotFoundError("conversation");
  return c;
}

/** Opens (or reuses) the buyer's single conversation about a live listing. Sellers can't message themselves. */
export async function startConversation(db: Db, userId: string, listingId: string): Promise<string> {
  const listing = await db.listing.findFirst({ where: { id: listingId, status: "LIVE" }, select: { id: true, sellerId: true } });
  if (!listing) throw new NotFoundError("listing");
  if (listing.sellerId === userId) throw new UserError("This is your own listing. Buyers' messages about it appear in your inbox.");
  const c = await db.conversation.upsert({
    where: { listingId_buyerId: { listingId, buyerId: userId } },
    create: { listingId, buyerId: userId, sellerId: listing.sellerId },
    update: {},
    select: { id: true },
  });
  return c.id;
}

const listingSummarySelect = {
  id: true,
  title: true,
  pricePaise: true,
  status: true,
  isSample: true,
  photos: { where: { storageKey: { not: null } }, orderBy: { sortOrder: "asc" as const }, take: 1, select: { storageKey: true } },
} satisfies Prisma.ListingSelect;

async function listingSummary(deps: Deps | undefined, l: Prisma.ListingGetPayload<{ select: typeof listingSummarySelect }>) {
  const key = l.photos[0]?.storageKey;
  return {
    id: l.id,
    title: l.title ?? "Untitled part",
    pricePaise: l.pricePaise ?? 0,
    status: l.status,
    isSample: l.isSample,
    photoUrl: key && deps ? await deps.storage.createSignedDownloadUrl(deps.bucket, key, 600) : null,
  };
}

const unread = (myReadAt: Date | null, last: { createdAt: Date; mine: boolean } | undefined) => !!last && !last.mine && (!myReadAt || myReadAt < last.createdAt);

/** Inbox: the user's conversations, newest activity first, with the latest message and unread state. */
export async function listInbox(db: Db, deps: Deps | undefined, userId: string) {
  const rows = await db.conversation.findMany({
    where: { OR: [{ buyerId: userId }, { sellerId: userId }], messages: { some: {} } },
    orderBy: { lastMessageAt: "desc" },
    take: 100,
    select: {
      id: true,
      buyerId: true,
      buyerReadAt: true,
      sellerReadAt: true,
      lastMessageAt: true,
      buyer: { select: { name: true } },
      seller: { select: { name: true } },
      listing: { select: listingSummarySelect },
      messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, createdAt: true, senderId: true, wasMasked: true } },
    },
  });
  return Promise.all(
    rows.map(async (c) => {
      const iAmBuyer = c.buyerId === userId;
      const m = c.messages[0];
      const last = m ? { body: m.body, createdAt: m.createdAt, mine: m.senderId === userId, wasMasked: m.wasMasked } : undefined;
      return {
        id: c.id,
        role: iAmBuyer ? ("buyer" as const) : ("seller" as const),
        otherName: firstName(iAmBuyer ? c.seller.name : c.buyer.name),
        listing: await listingSummary(deps, c.listing),
        last,
        unread: unread(iAmBuyer ? c.buyerReadAt : c.sellerReadAt, last),
      };
    }),
  );
}

export type ThreadMessage = { id: string; body: string; mine: boolean; wasMasked: boolean; createdAt: string };

/** Messages after `after` (ISO time) for polling, or the full history. Participants only. */
export async function getMessages(db: Db, userId: string, conversationId: string, after?: string): Promise<ThreadMessage[]> {
  await participantConversation(db, userId, conversationId);
  const since = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : undefined;
  const rows = await db.message.findMany({
    where: { conversationId, ...(since ? { createdAt: { gt: since } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 500,
    select: { id: true, body: true, senderId: true, wasMasked: true, createdAt: true },
  });
  return rows.map((m) => ({ id: m.id, body: m.body, mine: m.senderId === userId, wasMasked: m.wasMasked, createdAt: m.createdAt.toISOString() }));
}

/** Thread page data: pinned listing, the other person's first name, and the history. */
export async function getThread(db: Db, deps: Deps | undefined, userId: string, conversationId: string) {
  const c = await participantConversation(db, userId, conversationId);
  const full = await db.conversation.findUniqueOrThrow({
    where: { id: c.id },
    select: { buyer: { select: { name: true } }, seller: { select: { name: true } }, listing: { select: listingSummarySelect } },
  });
  const iAmBuyer = c.buyerId === userId;
  return {
    id: c.id,
    role: iAmBuyer ? ("buyer" as const) : ("seller" as const),
    otherName: firstName(iAmBuyer ? full.seller.name : full.buyer.name),
    listing: await listingSummary(deps, full.listing),
    messages: await getMessages(db, userId, c.id),
  };
}

export const messageInput = z.object({
  conversationId: z.string().min(1),
  body: z.string().trim().min(1, "Write a message first.").max(MAX_MESSAGE_LENGTH, `Keep messages under ${MAX_MESSAGE_LENGTH} characters.`),
});

/**
 * Sends a message: participant check, rate limit (settings.rateLimits.messagesPerUser), server-side
 * masking, then the message, the conversation times and the recipient's notification in one transaction.
 * Only the masked text is ever stored.
 */
export async function sendMessage(db: Db, actor: Actor, input: unknown): Promise<ThreadMessage> {
  const data = messageInput.safeParse(input);
  if (!data.success) throw new FieldError({ body: data.error.issues[0]?.message ?? "Write a message first." });
  const c = await participantConversation(db, actor.userId, data.data.conversationId);
  await consumeRateLimit(db, "messagesPerUser", actor.userId);

  const body = maskContactDetails(data.data.body);
  const wasMasked = body !== data.data.body;
  const iAmBuyer = c.buyerId === actor.userId;
  const recipientId = iAmBuyer ? c.sellerId : c.buyerId;

  const message = await db.$transaction(async (tx) => {
    // Notify only for the first message the recipient hasn't seen yet, not for every message in a burst.
    const recipientReadAt = iAmBuyer ? c.sellerReadAt : c.buyerReadAt;
    const alreadyUnread = await tx.message.count({ where: { conversationId: c.id, senderId: actor.userId, ...(recipientReadAt ? { createdAt: { gt: recipientReadAt } } : {}) } });
    const m = await tx.message.create({ data: { conversationId: c.id, senderId: actor.userId, body, wasMasked } });
    await tx.conversation.update({ where: { id: c.id }, data: { lastMessageAt: m.createdAt, ...(iAmBuyer ? { buyerReadAt: m.createdAt } : { sellerReadAt: m.createdAt }) } });
    if (alreadyUnread === 0) {
      await enqueueOutbox(tx, {
        queue: "notifications",
        name: "send",
        payload: { userId: recipientId, channel: "IN_APP", type: "message.new", title: "New message", body: "You have a new message about a listing.", link: `/messages/${c.id}` },
      });
    }
    return m;
  });
  return { id: message.id, body: message.body, mine: true, wasMasked: message.wasMasked, createdAt: message.createdAt.toISOString() };
}

/** Marks the conversation read for the caller only. */
export async function markRead(db: Db, userId: string, conversationId: string) {
  const c = await participantConversation(db, userId, conversationId);
  await db.conversation.update({ where: { id: c.id }, data: c.buyerId === userId ? { buyerReadAt: new Date() } : { sellerReadAt: new Date() } });
}

export const MESSAGE_REPORT_REASONS = {
  ABUSIVE: "It's abusive or threatening",
  SCAM: "It looks like a scam or asks to pay outside RePart",
  SPAM: "It's spam",
  OTHER: "Something else",
} as const;

export const messageReportInput = z.object({
  messageId: z.string().min(1),
  reason: z.enum(Object.keys(MESSAGE_REPORT_REASONS) as [keyof typeof MESSAGE_REPORT_REASONS, ...Array<keyof typeof MESSAGE_REPORT_REASONS>], { message: "Choose a reason." }),
  details: z.string().trim().max(1000).optional().transform((v) => (v ? v : null)),
});

/** Report a message you received (Report model, target MESSAGE; one open report per member and message). */
export async function reportMessage(db: Db, reporterId: string, input: unknown) {
  const data = messageReportInput.parse(input);
  const m = await db.message.findFirst({
    where: { id: data.messageId, conversation: { OR: [{ buyerId: reporterId }, { sellerId: reporterId }] } },
    select: { id: true, senderId: true },
  });
  if (!m) throw new NotFoundError("message");
  if (m.senderId === reporterId) throw new UserError("You can't report your own message.");
  if (await db.report.findFirst({ where: { reporterId, messageId: m.id, status: "OPEN" } })) {
    throw new UserError("You've already reported this message. Our team will review it.");
  }
  return db.report.create({ data: { reporterId, targetType: "MESSAGE", messageId: m.id, reason: data.reason, details: data.details } });
}
