import "server-only";

export type CheckName = "database" | "redis" | "storage";
export type HealthReport = { status: "ok" | "degraded"; checks: Record<CheckName, "up" | "down"> };

const TIMEOUT_MS = 2_000;

function withTimeout(p: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs each check in parallel with a timeout. The report carries only up/down per dependency;
 * error messages are logged by the caller, never returned (PLAN.md §4.9: no details leaked).
 */
export async function runHealthChecks(
  checks: Record<CheckName, () => Promise<unknown>>,
  onError: (name: CheckName, err: unknown) => void = () => {},
  timeoutMs = TIMEOUT_MS,
): Promise<HealthReport> {
  const names = Object.keys(checks) as CheckName[];
  const results = await Promise.allSettled(names.map((n) => withTimeout(Promise.resolve().then(checks[n]), timeoutMs)));
  const report = { status: "ok", checks: {} } as HealthReport;
  names.forEach((name, i) => {
    const r = results[i]!;
    report.checks[name] = r.status === "fulfilled" ? "up" : "down";
    if (r.status === "rejected") {
      report.status = "degraded";
      onError(name, r.reason);
    }
  });
  return report;
}
