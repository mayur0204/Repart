import { checkDependencies } from "@/server/health-live";

export const dynamic = "force-dynamic";

/** GET /api/health: database, Redis and storage reachability. Public; returns only up/down per dependency. */
export async function GET() {
  const report = await checkDependencies();
  return Response.json(report, { status: report.status === "ok" ? 200 : 503, headers: { "cache-control": "no-store" } });
}
