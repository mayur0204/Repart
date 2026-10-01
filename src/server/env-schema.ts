import { z } from "zod";

/**
 * Environment schema (PLAN.md §1.2 "Secrets", §13).
 * Kept free of `server-only` so unit tests and scripts can import it;
 * runtime code must read env through `@/server/env`.
 */

const url = z.url();
const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// connection string");
const adapter = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.enum(values).default(fallback);

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: postgresUrl,
  DIRECT_URL: postgresUrl.optional(), // CLI only; not needed by the running app

  SUPABASE_URL: url,
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  STORAGE_PROVIDER: adapter(["supabase", "minio", "memory"] as const, "supabase"),
  STORAGE_BUCKET_LISTING_PHOTOS: z.string().default("listing-photos"),
  STORAGE_BUCKET_INSPECTION_PHOTOS: z.string().default("inspection-photos"),
  STORAGE_BUCKET_DISPUTE_EVIDENCE: z.string().default("dispute-evidence"),
  STORAGE_BUCKET_CATALOGUE_IMPORTS: z.string().default("catalogue-imports"),
  MINIO_ENDPOINT: url.optional(),
  MINIO_ACCESS_KEY: z.string().optional(),
  MINIO_SECRET_KEY: z.string().optional(),

  REDIS_URL: z.string().regex(/^rediss?:\/\//, "must be a redis:// or rediss:// URL").default("redis://127.0.0.1:6379"),

  APP_BASE_URL: url.default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  OTP_PROVIDER: adapter(["mock"] as const, "mock"),
  PAYMENT_PROVIDER: adapter(["mock", "cashfree"] as const, "mock"),
  // Cashfree Easy Split, TEST/SANDBOX only (decision D-9). Server-only; never logged or sent to the browser.
  CASHFREE_APP_ID: z.string().min(1).optional(),
  CASHFREE_SECRET_KEY: z.string().min(1).optional(),
  CASHFREE_ENV: z.literal("sandbox", { message: "only the Cashfree sandbox is allowed" }).default("sandbox"),
  SHIPPING_PROVIDER: adapter(["mock"] as const, "mock"),
  VISION_PROVIDER: adapter(["mock"] as const, "mock"),
  NOTIFICATION_PROVIDER: adapter(["mock"] as const, "mock"),
  MOCK_WEBHOOK_SECRET: z.string().min(16).optional(),
  SHIPPING_WEBHOOK_SECRET: z.string().min(16).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Names that must never be exposed to the browser via NEXT_PUBLIC_. */
export const SECRET_NAME_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|DATABASE|DIRECT_URL|SERVICE_ROLE|CASHFREE)/i;

/** Vercel Preview builds run with NODE_ENV=production, so on Vercel trust VERCEL_ENV instead. */
export function isProductionEnv(source: Record<string, string | undefined> = process.env): boolean {
  return source.VERCEL_ENV ? source.VERCEL_ENV === "production" : source.NODE_ENV === "production";
}

/** Parse env and return a readable error that never echoes secret values. */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  if (result.data.PAYMENT_PROVIDER === "cashfree" && !result.data.CASHFREE_APP_ID) {
    throw new Error("Invalid environment configuration:\n  - PAYMENT_PROVIDER=cashfree needs CASHFREE_APP_ID and CASHFREE_SECRET_KEY");
  }
  if (!result.data.CASHFREE_APP_ID !== !result.data.CASHFREE_SECRET_KEY) {
    throw new Error("Invalid environment configuration:\n  - CASHFREE_APP_ID and CASHFREE_SECRET_KEY must be set together");
  }
  if (isProductionEnv(source) && result.data.PAYMENT_PROVIDER === "mock") {
    throw new Error("Invalid environment configuration:\n  - PAYMENT_PROVIDER: mock is not allowed in production");
  }
  return result.data;
}

/** Keys that are designed to be public. The Supabase publishable key only identifies the project; RLS and the server guard data. */
const PUBLIC_KEY_NAMES = new Set(["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);

/** Returns NEXT_PUBLIC_* variable names that look like secrets. */
export function findExposedSecrets(source: Record<string, string | undefined>): string[] {
  return Object.keys(source).filter(
    (name) => name.startsWith("NEXT_PUBLIC_") && !PUBLIC_KEY_NAMES.has(name) && SECRET_NAME_PATTERN.test(name.slice("NEXT_PUBLIC_".length)),
  );
}
