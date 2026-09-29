import "server-only";
import { jobSchema, type QueueName } from "@/server/jobs/queues";
import { logger } from "@/server/logger";
import { photos, risk } from "@/server/services";

export type Handler = (payload: unknown, meta: { jobId: string | undefined }) => Promise<void>;

/**
 * Job handlers by queue and name. Handlers must be idempotent: the outbox guarantees
 * at-least-once delivery, not exactly-once. Later milestones register their jobs here.
 */
export const HANDLERS: Record<QueueName, Record<string, Handler>> = {
  system: {
    ping: async (_payload, meta) => {
      logger.info({ jobId: meta.jobId }, "system.ping handled");
    },
  },
  photos: {
    process: async (payload, meta) => {
      const result = await photos.process((payload as { photoId: string }).photoId);
      logger.info({ jobId: meta.jobId, result }, "photos.process handled");
    },
  },
  risk: {
    check: async (payload, meta) => {
      const outcome = await risk.run((payload as { listingId: string }).listingId);
      logger.info({ jobId: meta.jobId, outcome }, "risk.check handled");
    },
  },
  notifications: {
    send: async (_payload, meta) => {
      // M2 wires this to the NotificationProvider and writes NotificationDelivery rows.
      logger.info({ jobId: meta.jobId }, "notifications.send received (not wired until M2)");
    },
  },
};

/** Validate the payload again at the consumer, then run the handler. Unknown jobs fail loudly. */
export async function runJob(queue: string, name: string, payload: unknown, jobId?: string): Promise<void> {
  const schema = jobSchema(queue, name);
  const handler = HANDLERS[queue as QueueName]?.[name];
  if (!schema || !handler) throw new Error(`no handler for ${queue}.${name}`);
  await handler(schema.parse(payload), { jobId });
}
