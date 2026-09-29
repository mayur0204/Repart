import "server-only";
import { randomUUID } from "node:crypto";
import type { DeliveryResult, EmailMessage, InAppMessage, NotificationProvider, SmsMessage } from "./types";

type Sent = { channel: "SMS" | "EMAIL" | "IN_APP"; message: SmsMessage | EmailMessage | InAppMessage };

/**
 * Mock SMS/email/in-app: recorded in memory and logged without the phone or address.
 * The notification service (M2+) persists Notification / NotificationDelivery rows around these calls.
 */
export function createMockNotificationProvider(log: (msg: string) => void = console.info): NotificationProvider & { readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const record = async (channel: Sent["channel"], message: Sent["message"]): Promise<DeliveryResult> => {
    sent.push({ channel, message });
    log(`[mock notification] ${channel} to user ${message.userId}`);
    return { providerRef: `mock_${randomUUID()}`, status: "SENT" };
  };
  return {
    name: "mock",
    sent,
    sms: (m) => record("SMS", m),
    email: (m) => record("EMAIL", m),
    inApp: (m) => record("IN_APP", m),
  };
}
