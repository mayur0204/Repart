import "server-only";
import { Redis } from "ioredis";
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes, type RateLimiterAbstract } from "rate-limiter-flexible";
import type { PrismaClient } from "@/generated/prisma/client";
import { env } from "../env";
import { getActiveSettings } from "../services/settings/settings";
import type { Settings } from "../services/settings/schema";
import { RateLimitedError } from "./errors";

/**
 * Rate limiting (PLAN.md §1.2): Redis-backed, limits read from the active settings version.
 * If Redis is unreachable, an in-process limiter with the same limits takes over, so limits
 * are never silently disabled.
 */
export type RateLimitName = keyof Settings["rateLimits"];
export type RateLimit = Settings["rateLimits"][RateLimitName];

type Store = "redis" | "memory";
let store: Store = "redis";
let redis: Redis | undefined;
const limiters = new Map<string, RateLimiterAbstract>();

/** Tests use the in-memory store. Also clears existing counters. */
export function useRateLimitStore(next: Store): void {
  store = next;
  limiters.clear();
}

function limiterFor(name: RateLimitName, limit: RateLimit): RateLimiterAbstract {
  const id = `${store}:${name}:${limit.points}:${limit.windowSeconds}`;
  let limiter = limiters.get(id);
  if (!limiter) {
    const opts = { keyPrefix: `rl:${name}`, points: limit.points, duration: limit.windowSeconds };
    if (store === "memory") {
      limiter = new RateLimiterMemory(opts);
    } else {
      redis ??= new Redis(env().REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 2_000 });
      limiter = new RateLimiterRedis({ ...opts, storeClient: redis, insuranceLimiter: new RateLimiterMemory(opts) });
    }
    limiters.set(id, limiter);
  }
  return limiter;
}

/** Consumes one point or throws RateLimitedError with the wait time. */
export async function consumeWithLimit(name: RateLimitName, key: string, limit: RateLimit): Promise<void> {
  try {
    await limiterFor(name, limit).consume(key);
  } catch (err) {
    if (err instanceof RateLimiterRes) throw new RateLimitedError(Math.ceil(err.msBeforeNext / 1000));
    throw err;
  }
}

const SETTINGS_TTL_MS = 30_000;
let cachedLimits: { at: number; limits: Settings["rateLimits"] } | undefined;

export async function rateLimitsFromSettings(db: Pick<PrismaClient, "settingsVersion">): Promise<Settings["rateLimits"]> {
  if (!cachedLimits || Date.now() - cachedLimits.at > SETTINGS_TTL_MS) {
    cachedLimits = { at: Date.now(), limits: (await getActiveSettings(db)).settings.rateLimits };
  }
  return cachedLimits.limits;
}

/** Consumes one point against the limit configured in the active settings version. */
export async function consumeRateLimit(db: Pick<PrismaClient, "settingsVersion">, name: RateLimitName, key: string): Promise<void> {
  const limits = await rateLimitsFromSettings(db);
  await consumeWithLimit(name, key, limits[name]);
}

/** Throws RateLimitedError when `key` has no points left, without consuming one (pair with consumeRateLimit on failure). */
export async function assertWithinRateLimit(db: Pick<PrismaClient, "settingsVersion">, name: RateLimitName, key: string): Promise<void> {
  const limit = (await rateLimitsFromSettings(db))[name];
  const res = await limiterFor(name, limit).get(key);
  if (res && res.consumedPoints >= limit.points) throw new RateLimitedError(Math.ceil(res.msBeforeNext / 1000));
}

export function clearRateLimitSettingsCache(): void {
  cachedLimits = undefined;
}
