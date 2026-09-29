/**
 * Guard for integration/e2e tests and test seeding (PLAN.md §10).
 * Aborts unless the URL points at a local database whose name ends in "_test".
 * The Supabase development project can never be used as a disposable test database.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres-test"]);

export function assertLocalTestDatabase(url: string | undefined): URL {
  if (!url) throw new Error("TEST_DATABASE_URL is not set. Tests only run against the local Docker postgres-test.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL.");
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) throw new Error("TEST_DATABASE_URL must be a postgres URL.");
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing to use a non-local database for tests (host: ${parsed.hostname}).`);
  }
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to use a database whose name does not end in "_test" (got "${dbName}").`);
  }
  return parsed;
}
