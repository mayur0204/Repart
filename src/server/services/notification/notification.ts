import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { NotificationProvider } from "../../adapters/notification/types";
import type { JobPayload } from "../../jobs/queues";

/**
 * Worker job `notifications.send`: stores the in-app Notification row and records the delivery
 * through the NotificationProvider adapter (mock in development). SMS/email go through the same
 * adapter once a contact lookup exists; nothing in the app sends them yet.
 */
export async function deliverNotification(db: Pick<PrismaClient, "notification" | "notificationDelivery">, provider: NotificationProvider, payload: JobPayload<"notifications", "send">) {
  const n = await db.notification.create({ data: { userId: payload.userId, type: payload.type, title: payload.title, body: payload.body, link: payload.link ?? null } });
  const result = await provider.inApp({ userId: payload.userId, type: payload.type, title: payload.title, body: payload.body, link: payload.link });
  await db.notificationDelivery.create({ data: { notificationId: n.id, channel: "IN_APP", providerRef: result.providerRef, status: result.status } });
  return n.id;
}
