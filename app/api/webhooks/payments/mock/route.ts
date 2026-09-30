import { defineRoute } from "@/server/http/define-route";
import { handlePaymentWebhook } from "../webhook-route";

/** Mock provider webhooks (PLAN.md §4.9), signed with MOCK_WEBHOOK_SECRET. Refused unless PAYMENT_PROVIDER=mock. */
export const POST = defineRoute({ access: "public" }, (req) => handlePaymentWebhook("mock", req));
