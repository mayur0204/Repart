import { describe, expect, it } from "vitest";
import { findExposedSecrets, parseServerEnv } from "../../src/server/env-schema";

const valid = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://user:pass@pooler.example.test:6543/postgres",
  SUPABASE_URL: "https://example.supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
  SESSION_SECRET: "s".repeat(48),
};

describe("server env", () => {
  it("accepts a complete development env and applies mock adapter defaults", () => {
    const env = parseServerEnv(valid);
    expect(env.PAYMENT_PROVIDER).toBe("mock");
    expect(env.REDIS_URL).toBe("redis://127.0.0.1:6379");
  });

  it("rejects missing required values without echoing secret values", () => {
    const leaked = "leak-me-9f3a"; // too short to be valid, and must never appear in the error
    let message = "";
    try {
      parseServerEnv({ ...valid, SESSION_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: leaked });
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/SESSION_SECRET/);
    expect(message).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(message).not.toContain(leaked);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => parseServerEnv({ ...valid, DATABASE_URL: "mysql://x" })).toThrowError(/DATABASE_URL/);
  });

  it("does not accept cashfree before M8", () => {
    expect(() => parseServerEnv({ ...valid, PAYMENT_PROVIDER: "cashfree" })).toThrowError(/PAYMENT_PROVIDER/);
  });

  it("forbids the mock payment provider in production", () => {
    expect(() => parseServerEnv({ ...valid, NODE_ENV: "production" })).toThrowError(/mock is not allowed/);
  });

  it("flags secret-like NEXT_PUBLIC_ variables", () => {
    expect(
      findExposedSecrets({
        NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "x",
        NEXT_PUBLIC_DATABASE_URL: "x",
        NEXT_PUBLIC_APP_BASE_URL: "x",
      }),
    ).toEqual(["NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_DATABASE_URL"]);
  });

  it("the current process env exposes no secrets to the browser", () => {
    expect(findExposedSecrets(process.env)).toEqual([]);
  });
});
