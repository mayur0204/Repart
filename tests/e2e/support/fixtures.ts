import { createHmac, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { createSessionToken } from "./db";
import { E2E_BASE_URL, E2E_PAYMENT_SECRET, E2E_SHIPPING_SECRET } from "./env";

export const USERS = {
  admin: "sample-user-admin",
  mechanic: "sample-user-mechanic",
  seller: "sample-user-seller",
  sellerNoPayout: "sample-user-seller-nopayout",
  buyer: "sample-user-buyer",
  buyer2: "sample-user-buyer-2",
} as const;
export type Role = keyof typeof USERS;

/** Signs the browser context in as a seeded user (see createSessionToken for why this isn't done through the UI). */
export async function signInAs(context: BrowserContext, userId: string): Promise<void> {
  const token = await createSessionToken(userId);
  await context.addCookies([{ name: "repart_session", value: token, url: E2E_BASE_URL, httpOnly: true, secure: true, sameSite: "Lax" }]);
}

/** HMAC-SHA256 over timestamp + raw body, the scheme both mock providers verify (src/server/adapters/signing.ts). */
function signed(secret: string, body: string) {
  const ts = String(Date.now());
  return { "content-type": "application/json", "x-mock-timestamp": ts, "x-mock-signature": createHmac("sha256", secret).update(`${ts}${body}`).digest("hex") };
}

/** What the mock payment provider sends after a buyer pays on its hosted page. */
export async function payViaMockWebhook(request: APIRequestContext, orderId: string, amountPaise: number) {
  const body = JSON.stringify({ providerEventId: `e2e_evt_${randomUUID()}`, type: "PAYMENT_SUCCESS", providerType: "MOCK_PAYMENT_SUCCESS", orderId, providerPaymentId: `e2e_pay_${randomUUID()}`, amount: amountPaise, currency: "INR", at: new Date().toISOString() });
  const res = await request.post("/api/webhooks/payments/mock", { data: body, headers: signed(E2E_PAYMENT_SECRET, body) });
  expect(res.status(), await res.text()).toBe(200);
}

/** What the mock courier sends as a parcel moves. */
export async function trackingEvent(request: APIRequestContext, shipmentRef: string, status: "PICKED_UP" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED") {
  const body = JSON.stringify({ providerEventId: `e2e_trk_${randomUUID()}`, shipmentId: shipmentRef, status, at: new Date().toISOString(), location: "Mock hub" });
  const res = await request.post("/api/webhooks/shipping/mock", { data: body, headers: signed(E2E_SHIPPING_SECRET, body) });
  expect(res.status(), await res.text()).toBe(200);
}

export const unsignedPost = (request: APIRequestContext, path: string, body: string) => request.post(path, { data: body, headers: { "content-type": "application/json" } });

/** Server-action forms only work once React has hydrated; clicking earlier submits nothing. */
export async function gotoReady(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

/** axe at WCAG 2.1 AA (brief §10 "Accessibility"). */
export async function expectNoAxeViolations(page: Page) {
  // Page metadata streams in after the loading skeleton; check the finished page.
  await expect.poll(() => page.title()).not.toBe("");
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
