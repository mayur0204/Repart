import "dotenv/config";
import { assertLocalTestDatabase } from "../../setup/assert-test-db";

/**
 * Environment for the e2e web server and worker (PLAN.md §10 "End-to-end"): the local test Postgres, a separate Redis
 * database, mock providers and fixed local-only webhook secrets. Nothing here reads DATABASE_URL from .env.
 *
 * NODE_ENV=test at runtime: env-schema refuses mock payments when NODE_ENV=production, and e2e must use the mocks.
 * The build itself is a normal production build.
 *
 * Storage: the Supabase DEVELOPMENT project's private buckets, through the app's own Supabase storage adapter, so
 * uploads, worker processing and signed URLs run for real. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY come from .env,
 * which only ever points at the development project (PLAN.md §1.2 "Environments"); the key stays server-side (web
 * server, worker, and this test runner's cleanup). Objects the run creates are deleted in the global teardown.
 */
export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_PAYMENT_SECRET = "e2e-local-mock-payment-secret";
export const E2E_SHIPPING_SECRET = "e2e-local-mock-shipping-secret";
export const E2E_REDIS_URL = "redis://127.0.0.1:6379/1";

/** Fails the run early, naming what's missing, rather than silently skipping the photo journeys. */
export function devStorageConfig(): { url: string; serviceRoleKey: string } {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`E2E needs the Supabase development storage: set ${missing.join(" and ")} in .env.`);
  return { url: process.env.SUPABASE_URL!, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY! };
}

export const BUCKETS = {
  listing: process.env.STORAGE_BUCKET_LISTING_PHOTOS || "listing-photos",
  inspection: process.env.STORAGE_BUCKET_INSPECTION_PHOTOS || "inspection-photos",
  dispute: process.env.STORAGE_BUCKET_DISPUTE_EVIDENCE || "dispute-evidence",
};

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  assertLocalTestDatabase(url);
  return url!;
}

export function e2eEnv(): Record<string, string> {
  const url = testDatabaseUrl();
  devStorageConfig();
  const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  return {
    ...base,
    NODE_ENV: "test",
    DATABASE_URL: url,
    DIRECT_URL: url,
    REDIS_URL: E2E_REDIS_URL,
    APP_BASE_URL: E2E_BASE_URL,
    PAYMENT_PROVIDER: "mock",
    OTP_PROVIDER: "mock",
    SHIPPING_PROVIDER: "mock",
    VISION_PROVIDER: "mock",
    NOTIFICATION_PROVIDER: "mock",
    MOCK_WEBHOOK_SECRET: E2E_PAYMENT_SECRET,
    SHIPPING_WEBHOOK_SECRET: E2E_SHIPPING_SECRET,
    STORAGE_PROVIDER: "supabase",
    // Cashfree sandbox keys, if present in .env, are left alone and unused: PAYMENT_PROVIDER is mock.
    LOG_LEVEL: "warn",
  };
}
