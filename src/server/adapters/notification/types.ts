export type SmsMessage = { userId: string; phone: string; body: string };
export type EmailMessage = { userId: string; to: string; subject: string; body: string };
export type InAppMessage = { userId: string; type: string; title: string; body: string; link?: string };
export type DeliveryResult = { providerRef: string | null; status: "SENT" | "FAILED" };

/** Outbound notifications (REPART_BRIEF.md §3). Called only from outbox jobs, never inline in a request. */
export interface NotificationProvider {
  readonly name: string;
  sms(message: SmsMessage): Promise<DeliveryResult>;
  email(message: EmailMessage): Promise<DeliveryResult>;
  inApp(message: InAppMessage): Promise<DeliveryResult>;
}
