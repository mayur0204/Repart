import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { testDatabaseUrl } from "./env";

/** Raw SQL against the local test database only (guarded). Used for fixtures and assertions, never for app writes under test. */
export async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return withDb(async (c) => (await c.query(sql, params)).rows[0] as T | undefined);
}

/**
 * A session for a seeded user, stored the way src/server/auth/session.ts stores it (SHA-256 of the token).
 * Seeded users have reserved 55555 numbers, which a production build refuses at sign-in by design, so role journeys
 * start from a session; the sign-in journey itself is tested through the UI with a new account.
 */
export async function createSessionToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await withDb((c) =>
    c.query(`INSERT INTO "Session" (id, "userId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval '1 day')`, [`e2e_${randomBytes(8).toString("hex")}`, userId, hash]),
  );
  return token;
}

/** Polls until the query returns a row, e.g. waiting for the worker. */
export async function waitForRow<T = Record<string, unknown>>(sql: string, params: unknown[], timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const row = await one<T>(sql, params);
    if (row) return row;
    if (Date.now() > until) throw new Error(`timed out waiting for: ${sql}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
