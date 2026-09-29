import "server-only";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { Dispatch } from "../services/outbox/outbox";
import { QUEUES, type QueueName } from "./queues";

/** BullMQ requires maxRetriesPerRequest: null on connections used by workers. */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
}

export function createQueues(connection: Redis): Record<QueueName, Queue> {
  return Object.fromEntries(QUEUES.map((q) => [q, new Queue(q, { connection })])) as Record<QueueName, Queue>;
}

/** Outbox dispatch into BullMQ. jobId = outbox row id, so a repeated dispatch is deduplicated. */
export function bullmqDispatch(queues: Record<QueueName, Queue>): Dispatch {
  return async (job, delayMs) => {
    const queue = queues[job.queue as QueueName];
    if (!queue) throw new Error(`no queue named ${job.queue}`);
    await queue.add(job.name, job.payload, {
      jobId: job.id,
      delay: delayMs,
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  };
}
