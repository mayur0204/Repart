import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { createMockNotificationProvider } from "../../src/server/adapters/notification/mock";
import { createMemoryStorageProvider } from "../../src/server/adapters/storage/memory";
import { FieldError, NotFoundError, RateLimitedError, UserError } from "../../src/server/http/errors";
import { useRateLimitStore } from "../../src/server/http/rate-limit";
import { getMessages, getThread, listInbox, markRead, reportMessage, sendMessage, startConversation } from "../../src/server/services/messaging/messaging";
import { deliverNotification } from "../../src/server/services/notification/notification";
import { DEFAULT_SETTINGS } from "../../src/server/services/settings/schema";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const deps = { storage: createMemoryStorageProvider(), bucket: "listing-photos" };
const SELLER = "sample-user-seller";
const BUYER = "sample-user-buyer";
const STRANGER = "sample-user-buyer-2";
const LISTING = "sample-listing-live-tier-a"; // LIVE, sold by SAMPLE seller
const send = (userId: string, conversationId: string, body: string) => sendMessage(db, { userId }, { conversationId, body });
const notificationsFor = (userId: string, conversationId: string) =>
  db.outboxJob.count({ where: { queue: "notifications", AND: [{ payload: { path: ["userId"], equals: userId } }, { payload: { path: ["link"], equals: `/messages/${conversationId}` } }] } });

/** A fresh conversation per test, so counts don't leak between tests. */
async function freshConversation() {
  await db.message.deleteMany({ where: { conversation: { listingId: LISTING, buyerId: BUYER } } });
  await db.conversation.deleteMany({ where: { listingId: LISTING, buyerId: BUYER } });
  return startConversation(db, BUYER, LISTING);
}

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
beforeEach(() => useRateLimitStore("memory"));
afterAll(async () => {
  useRateLimitStore("redis");
  await db.report.deleteMany({ where: { targetType: "MESSAGE" } });
  await db.message.deleteMany({ where: { conversation: { listingId: LISTING } } });
  await db.conversation.deleteMany({ where: { listingId: LISTING } });
  await db.$disconnect();
});

describe("conversations", () => {
  it("one conversation per listing per buyer: opening again returns the same one", async () => {
    const a = await freshConversation();
    expect(await startConversation(db, BUYER, LISTING)).toBe(a);
    expect(await db.conversation.count({ where: { listingId: LISTING, buyerId: BUYER } })).toBe(1);
    expect(await db.conversation.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ sellerId: SELLER, buyerId: BUYER });
  });

  it("a seller has separate conversations with different buyers", async () => {
    const a = await freshConversation();
    const b = await startConversation(db, STRANGER, LISTING);
    expect(a).not.toBe(b);
  });

  it("sellers can't message themselves; non-live listings can't be messaged", async () => {
    await expect(startConversation(db, SELLER, LISTING)).rejects.toBeInstanceOf(UserError);
    await expect(startConversation(db, BUYER, "sample-listing-draft")).rejects.toBeInstanceOf(NotFoundError);
    await expect(startConversation(db, BUYER, "no-such-listing")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("authorization", () => {
  it("participants can read; anyone else gets NotFound for the thread, polling, sending and read state", async () => {
    const c = await freshConversation();
    await send(BUYER, c, "Is it still available?");
    expect((await getThread(db, deps, BUYER, c)).messages).toHaveLength(1);
    expect((await getThread(db, deps, SELLER, c)).messages).toHaveLength(1);
    for (const attempt of [
      () => getThread(db, deps, STRANGER, c),
      () => getMessages(db, STRANGER, c),
      () => send(STRANGER, c, "hello"),
      () => markRead(db, STRANGER, c),
      () => getThread(db, deps, BUYER, "someone-elses-conversation-id"),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(await db.message.count({ where: { conversationId: c } })).toBe(1);
  });
});

describe("sending, masking and read state", () => {
  it("stores only the masked text, sets wasMasked, and never keeps the original", async () => {
    const c = await freshConversation();
    const cases: Array<[string, boolean]> = [
      ["Call me on 98765 43210", true],
      ["mail rider@example.com", true],
      ["UPI rider@okaxis", true],
      ["nine eight seven six five four three two one zero, a@b.com and x@ybl", true],
      ["Does it fit a 2019 Roadster? ₹650 ok?", false],
    ];
    for (const [text, expectMasked] of cases) {
      const m = await send(BUYER, c, text);
      expect(m.wasMasked).toBe(expectMasked);
      const row = await db.message.findUniqueOrThrow({ where: { id: m.id } });
      expect(row.wasMasked).toBe(expectMasked);
      if (expectMasked) expect(row.body).toMatch(/\[contact details hidden\]/);
      else expect(row.body).toBe(text);
    }
    const all = (await db.message.findMany({ where: { conversationId: c } })).map((m) => m.body).join(" ");
    for (const secret of ["98765", "43210", "rider@example.com", "rider@okaxis", "nine eight", "a@b.com", "x@ybl"]) expect(all).not.toContain(secret);
  });

  it("rejects empty and oversized messages without storing anything", async () => {
    const c = await freshConversation();
    await expect(send(BUYER, c, "   ")).rejects.toBeInstanceOf(FieldError);
    await expect(send(BUYER, c, "x".repeat(2001))).rejects.toBeInstanceOf(FieldError);
    expect(await db.message.count({ where: { conversationId: c } })).toBe(0);
  });

  it("unread for the recipient until they read it; each side's read state is its own", async () => {
    const c = await freshConversation();
    await send(BUYER, c, "Hello, is it available?");
    const sellerInbox = await listInbox(db, deps, SELLER);
    expect(sellerInbox.find((t) => t.id === c)).toMatchObject({ unread: true, role: "seller", otherName: "Sample" });
    expect((await listInbox(db, deps, BUYER)).find((t) => t.id === c)?.unread).toBe(false);
    await markRead(db, SELLER, c);
    expect((await listInbox(db, deps, SELLER)).find((t) => t.id === c)?.unread).toBe(false);
    expect((await listInbox(db, deps, STRANGER)).some((t) => t.id === c)).toBe(false);
  });

  it("polling returns only messages after the given time", async () => {
    const c = await freshConversation();
    const first = await send(BUYER, c, "first");
    await send(SELLER, c, "second");
    const after = await getMessages(db, BUYER, c, first.createdAt);
    expect(after.map((m) => [m.body, m.mine])).toEqual([["second", false]]);
  });
});

describe("rate limiting (settings.rateLimits.messagesPerUser)", () => {
  it("rejects the message over the limit cleanly and stores nothing for it", async () => {
    const c = await freshConversation();
    const limit = DEFAULT_SETTINGS.rateLimits.messagesPerUser.points;
    for (let i = 0; i < limit; i++) await send(BUYER, c, `message ${i}`);
    await expect(send(BUYER, c, "one too many")).rejects.toBeInstanceOf(RateLimitedError);
    expect(await db.message.count({ where: { conversationId: c } })).toBe(limit);
    expect(await db.message.count({ where: { conversationId: c, body: "one too many" } })).toBe(0);
  });
});

describe("reporting a message", () => {
  it("participants can report the other person's message once; not their own; strangers can't", async () => {
    const c = await freshConversation();
    const m = await send(SELLER, c, "Pay me outside the app please");
    const r = await reportMessage(db, BUYER, { messageId: m.id, reason: "SCAM" });
    expect(r).toMatchObject({ targetType: "MESSAGE", messageId: m.id, status: "OPEN", reporterId: BUYER });
    await expect(reportMessage(db, BUYER, { messageId: m.id, reason: "OTHER" })).rejects.toThrow(/already reported/);
    await expect(reportMessage(db, SELLER, { messageId: m.id, reason: "SPAM" })).rejects.toThrow(/your own message/);
    await expect(reportMessage(db, STRANGER, { messageId: m.id, reason: "SPAM" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(reportMessage(db, BUYER, { messageId: m.id, reason: "NOPE" })).rejects.toThrow();
  });
});

describe("notifications (outbox → worker → Notification row)", () => {
  it("queues one in-app notification for the recipient, none for the sender, and none for the rest of an unread burst", async () => {
    const c = await freshConversation();
    await send(BUYER, c, "one");
    await send(BUYER, c, "two");
    expect(await notificationsFor(SELLER, c)).toBe(1);
    expect(await notificationsFor(BUYER, c)).toBe(0);
    await markRead(db, SELLER, c);
    await send(BUYER, c, "three");
    expect(await notificationsFor(SELLER, c)).toBe(2);
    await send(SELLER, c, "reply");
    expect(await notificationsFor(BUYER, c)).toBe(1);
  });

  it("the worker handler stores the Notification and a delivery record through the adapter", async () => {
    const provider = createMockNotificationProvider(() => {});
    const id = await deliverNotification(db, provider, { userId: SELLER, channel: "IN_APP", type: "message.new", title: "New message", body: "You have a new message about a listing.", link: "/messages/x" });
    expect(await db.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({ userId: SELLER, type: "message.new", readAt: null });
    expect(await db.notificationDelivery.findFirstOrThrow({ where: { notificationId: id } })).toMatchObject({ channel: "IN_APP", status: "SENT" });
    expect(provider.sent).toHaveLength(1);
  });
});

describe("privacy", () => {
  it("inbox and thread expose no phone, email, address, ids of the other user, risk or storage data", async () => {
    const c = await freshConversation();
    await send(BUYER, c, "hi");
    const json = JSON.stringify([await listInbox(db, deps, BUYER), await getThread(db, deps, BUYER, c)]);
    for (const secret of ["+91", "phone", "email", "Sample building", "sellerId", "buyerId", "senderId", "storageKey", "latestRiskScore", "sellerMessage", SELLER, BUYER]) {
      expect(json).not.toContain(secret);
    }
  });
});
