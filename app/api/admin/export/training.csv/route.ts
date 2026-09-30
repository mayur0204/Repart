import { defineRoute } from "@/server/http/define-route";
import { admin } from "@/server/services";

/**
 * Training-data CSV (PLAN.md §4.9, brief §5): streamed, one row per listing, fixed columns, sample data excluded
 * unless ?includeSample=true. Every export is audited (who, when, options). Admin only.
 */
export const GET = defineRoute({ access: ["ADMIN"] }, async (req, ctx) => {
  const includeSample = new URL(req.url).searchParams.get("includeSample") === "true";
  await admin.auditExport({ userId: ctx.user.id, requestId: ctx.requestId }, includeSample);
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(admin.exportStream(includeSample), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="repart-training-${stamp}${includeSample ? "-with-samples" : ""}.csv"`,
      "cache-control": "no-store",
    },
  });
});
