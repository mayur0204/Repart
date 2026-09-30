import { defineRoute } from "@/server/http/define-route";
import { fulfilment } from "@/server/services";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Courier tracking webhooks (PLAN.md §4.9). Public by design (couriers can't sign in): authenticity comes from
 * the signature over timestamp + raw body, checked before anything is parsed. Duplicates return 200; processing
 * failures return 500 so the courier retries.
 */
export const POST = defineRoute({ access: "public" }, async (req, ctx) => {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return Response.json({ ok: false }, { status: 413 });
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return Response.json({ ok: false }, { status: 413 });
  const result = await fulfilment.trackingWebhook(ctx.params.provider ?? "", rawBody, req.headers);
  return Response.json({ ok: result.status === 200, outcome: result.outcome }, { status: result.status });
});
