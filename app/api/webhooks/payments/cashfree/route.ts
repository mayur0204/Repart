import { defineRoute } from "@/server/http/define-route";
import { handlePaymentWebhook } from "../webhook-route";

/** Cashfree payment, refund and settlement webhooks (PLAN.md §4.9). Signature and timestamp verified before anything is read. */
export const POST = defineRoute({ access: "public" }, (req) => handlePaymentWebhook("cashfree", req));
