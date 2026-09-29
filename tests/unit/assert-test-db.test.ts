import { describe, expect, it } from "vitest";
import { assertLocalTestDatabase } from "../setup/assert-test-db";

describe("test database guard", () => {
  it("accepts the local docker test database", () => {
    expect(() => assertLocalTestDatabase("postgresql://repart:pw@127.0.0.1:54329/repart_test")).not.toThrow();
    expect(() => assertLocalTestDatabase("postgresql://repart:pw@localhost:54329/repart_test")).not.toThrow();
  });

  it.each([
    ["missing", undefined],
    ["a Supabase pooler host", "postgresql://postgres.ref:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres"],
    ["a Supabase direct host", "postgresql://postgres:pw@db.ref.supabase.co:5432/postgres"],
    ["a local non-test database", "postgresql://repart:pw@127.0.0.1:54329/repart"],
    ["a non-postgres URL", "mysql://repart:pw@127.0.0.1:3306/repart_test"],
  ])("rejects %s", (_label, url) => {
    expect(() => assertLocalTestDatabase(url)).toThrow();
  });
});
