import { defineRoute } from "@/server/http/define-route";
import { risk } from "@/server/services";

export const dynamic = "force-dynamic";

/** GET /api/listings/[id]/check-status: polled by "Checking your listing" (PLAN.md §4.9). Owner only. */
export const GET = defineRoute({ access: "member" }, async (_req, ctx) => {
  const status = await risk.statusForOwner(ctx.user.id, ctx.params.id ?? "");
  return Response.json(status, { headers: { "cache-control": "no-store" } });
});
