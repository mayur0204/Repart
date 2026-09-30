import { z } from "zod";

/**
 * Queue names and job payload schemas (PLAN.md §1.2 "Side effects").
 * Every job goes through the outbox, and every payload is validated on enqueue and again in the worker.
 * Later milestones add their jobs here (photo processing, risk check, timers, notifications, ...).
 */
export const QUEUES = ["system", "notifications", "photos", "risk", "searches", "orders"] as const;
export type QueueName = (typeof QUEUES)[number];

export const JOBS = {
  system: {
    ping: z.object({ note: z.string().max(200).optional() }),
  },
  notifications: {
    // Wired to the NotificationProvider in M2; the schema is fixed now so producers can be written against it.
    send: z.object({
      userId: z.string().min(1),
      channel: z.enum(["SMS", "EMAIL", "IN_APP"]),
      type: z.string().min(1),
      title: z.string().min(1),
      body: z.string().min(1),
      link: z.string().optional(),
    }),
  },
  photos: {
    // M4: re-encode an uploaded listing photo (EXIF/GPS removed) and measure quality.
    process: z.object({ photoId: z.string().min(1) }),
  },
  risk: {
    // Enqueued on listing submit (PLAN.md §5.1 L1). The risk pipeline itself is M5.
    check: z.object({ listingId: z.string().min(1) }),
  },
  searches: {
    // M6: a listing went LIVE; alert matching saved searches (PLAN.md §5.1 L5).
    alert: z.object({ listingId: z.string().min(1) }),
  },
  orders: {
    // M8 timers and money follow-ups (PLAN.md §5.2, §7.2). All handlers are idempotent.
    expirePayment: z.object({ orderId: z.string().min(1) }), // O3 at paymentExpiresAt
    sellerTimeout: z.object({ orderId: z.string().min(1) }), // O8 at sellerConfirmBy
    releaseSettlement: z.object({ orderId: z.string().min(1) }), // §7.2 step 6 on COMPLETED / RESOLVED_RELEASE
    processRefund: z.object({ refundId: z.string().min(1) }), // send / re-check a Refund with the provider
    acceptanceTimeout: z.object({ orderId: z.string().min(1) }), // O19 at acceptanceEndsAt (M11)
  },
} as const satisfies Record<QueueName, Record<string, z.ZodType>>;

export type JobName<Q extends QueueName> = keyof (typeof JOBS)[Q] & string;
export type JobPayload<Q extends QueueName, N extends JobName<Q>> = z.infer<(typeof JOBS)[Q][N]>;

export function jobSchema(queue: string, name: string): z.ZodType | undefined {
  const jobs = (JOBS as Record<string, Record<string, z.ZodType>>)[queue];
  return jobs?.[name];
}
