import "server-only";
import type { OutboxJob, Prisma, PrismaClient } from "@/generated/prisma/client";
import { jobSchema, type JobName, type JobPayload, type QueueName } from "../../jobs/queues";

type OutboxTx = Pick<Prisma.TransactionClient, "outboxJob">;

export const OUTBOX_MAX_ATTEMPTS = 5;
export const SWEEP_AFTER_MS = 60_000;

/**
 * Write a side effect as an OutboxJob row inside the caller's transaction (PLAN.md §1.2 "Side effects").
 * The payload is validated now so a bad job fails the business transaction, not the worker later.
 */
export async function enqueueOutbox<Q extends QueueName, N extends JobName<Q>>(
  tx: OutboxTx,
  job: { queue: Q; name: N; payload: JobPayload<Q, N>; runAt?: Date },
): Promise<string> {
  const schema = jobSchema(job.queue, job.name);
  if (!schema) throw new Error(`unknown job ${job.queue}.${job.name}`);
  const payload = schema.parse(job.payload) as Prisma.InputJsonValue;
  const row = await tx.outboxJob.create({
    data: { queue: job.queue, name: job.name, payload, runAt: job.runAt ?? new Date() },
    select: { id: true },
  });
  return row.id;
}

/** Pushes one outbox row to the queue. The outbox id is used as the job id, so a repeat push is a no-op. */
export type Dispatch = (job: Pick<OutboxJob, "id" | "queue" | "name" | "payload">, delayMs: number) => Promise<void>;

export type RelayResult = { dispatched: number; failed: number };

/**
 * Relay PENDING rows to the queue and mark them DISPATCHED.
 * `olderThanMs` turns this into the sweeper: only rows the normal relay missed.
 */
export async function relayOutbox(
  db: Pick<PrismaClient, "outboxJob">,
  dispatch: Dispatch,
  opts: { limit?: number; olderThanMs?: number; now?: Date } = {},
): Promise<RelayResult> {
  const now = opts.now ?? new Date();
  const createdBefore = opts.olderThanMs === undefined ? undefined : new Date(now.getTime() - opts.olderThanMs);
  const rows = await db.outboxJob.findMany({
    where: { status: "PENDING", ...(createdBefore ? { createdAt: { lt: createdBefore } } : {}) },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 100,
  });

  const result: RelayResult = { dispatched: 0, failed: 0 };
  for (const row of rows) {
    try {
      await dispatch(row, Math.max(0, row.runAt.getTime() - now.getTime()));
      await db.outboxJob.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: { status: "DISPATCHED", dispatchedAt: new Date(), attempts: { increment: 1 } },
      });
      result.dispatched++;
    } catch {
      const attempts = row.attempts + 1;
      await db.outboxJob.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: { attempts, status: attempts >= OUTBOX_MAX_ATTEMPTS ? "FAILED" : "PENDING" },
      });
      result.failed++;
    }
  }
  return result;
}
