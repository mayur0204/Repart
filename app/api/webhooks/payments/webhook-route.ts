import { orders } from "@/server/services";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Shared body of the payment webhook routes. Public by design (providers can't sign in): authenticity
 * comes from the webhook signature and timestamp, checked on the raw body before it is parsed.
 * Duplicates return 200; processing failures return 500 so the provider retries.
 */
export async function handlePaymentWebhook(provider: "cashfree" | "mock", req: Request): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return Response.json({ ok: false }, { status: 413 });
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return Response.json({ ok: false }, { status: 413 });
  const result = await orders.webhook(provider, rawBody, req.headers);
  return Response.json({ ok: result.status === 200, outcome: result.outcome }, { status: result.status });
}
