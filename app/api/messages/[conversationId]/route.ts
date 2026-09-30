import { defineRoute } from "@/server/http/define-route";
import { messaging } from "@/server/services";

export const dynamic = "force-dynamic";

/** GET /api/messages/[conversationId]?after=ISO: message polling (PLAN.md §4.9). Participants only. */
export const GET = defineRoute({ access: "member" }, async (req, ctx) => {
  const after = new URL(req.url).searchParams.get("after") ?? undefined;
  const messages = await messaging.messages(ctx.user.id, ctx.params.conversationId ?? "", after);
  return Response.json({ messages }, { headers: { "cache-control": "no-store" } });
});
