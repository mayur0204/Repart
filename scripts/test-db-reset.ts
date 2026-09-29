/**
 * Recreates the LOCAL test database schema and applies all Prisma migrations to it.
 * Guarded: refuses anything but a local *_test database (tests/setup/assert-test-db.ts).
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertLocalTestDatabase } from "../tests/setup/assert-test-db";

export async function resetTestDatabase(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  assertLocalTestDatabase(url);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    // Re-apply the Supabase-like role setup so migrations are tested against the same grants.
    await client.query(readFileSync(join(process.cwd(), "docker", "postgres-test", "init.sql"), "utf8"));
  } finally {
    await client.end();
  }

  // Prisma CLI reads DIRECT_URL (prisma.config.ts); point it at the local test DB for this call only.
  execFileSync(process.execPath, [join(process.cwd(), "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DIRECT_URL: url, DATABASE_URL: url },
  });
}

const invokedDirectly = process.argv[1] && /test-db-reset\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  resetTestDatabase()
    .then(() => console.log("Local test database reset and migrated."))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
