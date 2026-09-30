import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import Redis from "ioredis";
import { E2E_REDIS_URL, e2eEnv, testDatabaseUrl } from "./support/env";
import { devStorage, removeRunObjects } from "./support/storage";

/**
 * E2E setup (PLAN.md §10): guard → recreate + migrate the local test database → seed SAMPLE data → empty the e2e Redis
 * database → check the Supabase development storage is reachable → start the worker. Returns the teardown, which
 * stops the worker through its graceful shutdown and deletes the storage objects the run created.
 */
const root = process.cwd();
const tsx = (script: string, args: string[] = []) =>
  execFileSync(process.execPath, ["--import", "tsx", join(root, script), ...args], { stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } });

function startWorker(env: Record<string, string>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const worker = fork(join(root, "src/worker/index.ts"), [], { execArgv: ["--import", "tsx", "--conditions=react-server"], env: env as NodeJS.ProcessEnv, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const timer = setTimeout(() => reject(new Error("worker did not start within 60s")), 60_000);
    worker.once("message", (m) => {
      if (m === "ready") {
        clearTimeout(timer);
        resolve(worker);
      }
    });
    worker.once("exit", (code) => reject(new Error(`worker exited during start (code ${code})`)));
  });
}

async function stopWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null) return;
  const exited = new Promise<void>((r) => worker.once("exit", () => r()));
  worker.send("shutdown");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
  if (worker.exitCode === null) worker.kill();
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  testDatabaseUrl(); // throws unless local *_test
  tsx("scripts/test-db-reset.ts");
  tsx("prisma/seed/seed.ts", ["--target=test"]);

  const redis = new Redis(E2E_REDIS_URL, { lazyConnect: true });
  await redis.connect();
  await redis.flushdb(); // DB 1 is e2e-only; development uses DB 0
  await redis.quit();

  const { error } = await devStorage().listBuckets();
  if (error) throw new Error(`Supabase development storage is not reachable: ${error.message}`);
  const worker = await startWorker(e2eEnv());
  return async () => {
    await stopWorker(worker);
    const { removed } = await removeRunObjects();
    console.log(`[e2e] removed ${removed} storage objects created by this run`);
  };
}
