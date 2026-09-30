import "dotenv/config";
import "server-only";
import { Worker } from "bullmq";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { bullmqDispatch, createQueues, createRedis } from "@/server/jobs/bullmq";
import { QUEUES } from "@/server/jobs/queues";
import { logger } from "@/server/logger";
import { orders } from "@/server/services";
import { relayOutbox, SWEEP_AFTER_MS } from "@/server/services/outbox/outbox";
import { runJob } from "./handlers";

/**
 * Worker process (PLAN.md §1.1): BullMQ consumers + the outbox relay and sweeper.
 * Run with `npm run worker`. M8 adds the order sweep (missed timers, settlement sync, deadline breach)
 * every minute and the payment reconciliation once a day.
 */
const RELAY_INTERVAL_MS = 1_000;
const SWEEP_INTERVAL_MS = 60_000;
const ORDER_SWEEP_INTERVAL_MS = 60_000;
const RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;

async function main() {
  const connection = createRedis(env().REDIS_URL);
  await connection.connect();
  const queues = createQueues(connection);
  const dispatch = bullmqDispatch(queues);

  const workers = QUEUES.map(
    (queue) =>
      new Worker(queue, (job) => runJob(queue, job.name, job.data, job.id), { connection: connection.duplicate(), concurrency: 5 }),
  );
  for (const w of workers) {
    w.on("failed", (job, err) => logger.error({ queue: w.name, jobId: job?.id, err: err.message }, "job failed"));
  }

  let relaying = false;
  const relay = async (olderThanMs?: number) => {
    if (relaying) return;
    relaying = true;
    try {
      const r = await relayOutbox(db, dispatch, { olderThanMs });
      if (r.dispatched || r.failed) logger.info({ ...r, sweep: olderThanMs !== undefined }, "outbox relay");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "outbox relay error");
    } finally {
      relaying = false;
    }
  };
  const relayTimer = setInterval(() => void relay(), RELAY_INTERVAL_MS);
  const sweepTimer = setInterval(() => void relay(SWEEP_AFTER_MS), SWEEP_INTERVAL_MS);
  const safely = (name: string, fn: () => Promise<unknown>) => async () => {
    try {
      logger.info({ result: await fn() }, `${name} done`);
    } catch (err) {
      logger.error({ err: (err as Error).message }, `${name} failed`);
    }
  };
  const orderTimer = setInterval(safely("order sweep", orders.sweep), ORDER_SWEEP_INTERVAL_MS);
  // The mock provider keeps its state in the web process, so reconciling against it here would only report noise.
  const reconcileTimer = env().PAYMENT_PROVIDER === "mock" ? null : setInterval(safely("reconciliation", orders.reconcile), RECONCILE_INTERVAL_MS);
  logger.info({ queues: QUEUES }, "worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker stopping");
    clearInterval(relayTimer);
    clearInterval(sweepTimer);
    clearInterval(orderTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(Object.values(queues).map((q) => q.close()));
    await connection.quit();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, "worker failed to start");
  process.exit(1);
});
