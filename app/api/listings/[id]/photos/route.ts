import { defineRoute } from "@/server/http/define-route";
import { photos } from "@/server/services";

export const dynamic = "force-dynamic";

/** GET /api/listings/[id]/photos: the owner's photos with processing status and short-lived view URLs (polled by the uploader). */
export const GET = defineRoute({ access: "member" }, async (_req, ctx) => {
  const list = await photos.listForOwner(ctx.user.id, ctx.params.id ?? "");
  return Response.json({ photos: list }, { headers: { "cache-control": "no-store" } });
});
