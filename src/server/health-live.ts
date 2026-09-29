import "server-only";
import { adapters } from "./adapters";
import { db } from "./db";
import { env } from "./env";
import { runHealthChecks, type HealthReport } from "./health";
import { createRedis } from "./jobs/bullmq";
import { logger } from "./logger";

/** Live dependency checks for GET /api/health: database, Redis, storage. */
export function checkDependencies(): Promise<HealthReport> {
  return runHealthChecks(
    {
      database: () => db.$queryRaw`SELECT 1`,
      redis: async () => {
        const redis = createRedis(env().REDIS_URL);
        try {
          await redis.connect();
          await redis.ping();
        } finally {
          redis.disconnect();
        }
      },
      storage: () => adapters().storage.ping(),
    },
    (name, err) => logger.warn({ check: name, err: err instanceof Error ? err.message : String(err) }, "health check failed"),
  );
}
