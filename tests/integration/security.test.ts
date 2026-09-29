import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testPg } from "../setup/test-db";

let client: pg.Client;

beforeAll(async () => {
  client = await testPg();
});
afterAll(async () => {
  await client.end();
});

describe("RLS and public API lockdown (PLAN.md §2)", () => {
  it("every table in public has RLS enabled (incl. _prisma_migrations)", async () => {
    const { rows } = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity ORDER BY tablename",
    );
    expect(rows.map((r) => r.tablename)).toEqual([]);

    const { rows: all } = await client.query("SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations'");
    expect(all).toHaveLength(1);
  });

  it("no RLS policies exist in public", async () => {
    const { rows } = await client.query("SELECT policyname FROM pg_policies WHERE schemaname = 'public'");
    expect(rows).toEqual([]);
  });

  it.each(["anon", "authenticated"])("%s has no privileges on any public table", async (role) => {
    const { rows } = await client.query<{ table_name: string; privilege_type: string }>(
      "SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = $1",
      [role],
    );
    expect(rows).toEqual([]);
  });

  it.each(["anon", "authenticated"])("%s cannot read data even when switching role", async (role) => {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL ROLE ${role}`);
      await expect(client.query('SELECT * FROM "User" LIMIT 1')).rejects.toThrow(/permission denied/);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
