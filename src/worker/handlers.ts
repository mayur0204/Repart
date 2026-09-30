import "server-only";
import { jobSchema, type JobPayload, type QueueName } from "@/server/jobs/queues";
import { logger } from "@/server/logger";
import { messaging, photos, publicSearch, risk } from "@/server/services";

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
  searches: {
    alert: async (payload, meta) => {
      const count = await publicSearch.alertSavedSearches((payload as { listingId: string }).listingId);
      logger.info({ jobId: meta.jobId, count }, "searches.alert handled");
    },
  },
  notifications: {
    send: async (payload, meta) => {
      const id = await messaging.deliverNotification(payload as JobPayload<"notifications", "send">);
      logger.info({ jobId: meta.jobId, notificationId: id }, "notifications.send handled");
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
