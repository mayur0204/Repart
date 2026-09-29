import { z } from "zod";

/**
 * Queue names and job payload schemas (PLAN.md §1.2 "Side effects").
 * Every job goes through the outbox, and every payload is validated on enqueue and again in the worker.
 * Later milestones add their jobs here (photo processing, risk check, timers, notifications, ...).
 */
export const QUEUES = ["system", "notifications"] as const;
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
} as const satisfies Record<QueueName, Record<string, z.ZodType>>;

export type JobName<Q extends QueueName> = keyof (typeof JOBS)[Q] & string;
export type JobPayload<Q extends QueueName, N extends JobName<Q>> = z.infer<(typeof JOBS)[Q][N]>;

export function jobSchema(queue: string, name: string): z.ZodType | undefined {
  const jobs = (JOBS as Record<string, Record<string, z.ZodType>>)[queue];
  return jobs?.[name];
}
