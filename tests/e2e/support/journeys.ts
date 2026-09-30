import { expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { copyListing, orderFor, waitForOrderState } from "./data";
import { waitForRow } from "./db";
import { gotoReady, payViaMockWebhook, signInAs, trackingEvent, USERS } from "./fixtures";

/** Buyer checks out a copy of a seeded listing and the mock provider confirms payment. Returns the paid order. */
export async function buyListing(page: Page, request: APIRequestContext, fromListingId: string, opts: { withCheck?: boolean } = {}) {
  const listing = await copyListing(fromListingId);
  await signInAs(page.context(), USERS.buyer);
  await gotoReady(page, `/checkout/${listing.id}${opts.withCheck ? "?check=1" : ""}`);
  await page.getByRole("button", { name: /^Pay / }).click();
  await page.waitForURL(/\/dev\/mock-checkout\//);
  const order = await orderFor(listing.id);
  await payViaMockWebhook(request, order.id, order.totalPaise);
  await waitForOrderState(order.id, "AWAITING_SELLER");
  return { listing, orderId: order.id };
}

/** Seller confirms with the first offered slot(s). */
export async function sellerConfirms(seller: Page, orderId: string) {
  await gotoReady(seller, `/seller/orders/${orderId}`);
  const button = seller.getByRole("button", { name: "Confirm order" });
  await button.click();
  const error = seller.locator("form").filter({ has: button }).getByRole("alert");
  await expect(button.or(error).first()).toBeVisible();
  await expect(async () => {
    if (await error.isVisible()) throw new Error(`Confirm order refused: ${await error.innerText()}
${(await seller.locator("main").innerText()).slice(0, 1500)}`);
    await expect(button).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/** Courier events through the signed tracking webhook until the order is in its acceptance window. */
export async function deliver(request: APIRequestContext, orderId: string) {
  await waitForOrderState(orderId, "PICKUP_SCHEDULED");
  const shipment = await waitForRow<{ providerRef: string }>(`SELECT "providerRef" FROM "Shipment" WHERE "orderId" = $1 AND "providerRef" IS NOT NULL`, [orderId]);
  for (const status of ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"] as const) await trackingEvent(request, shipment.providerRef, status);
  await waitForOrderState(orderId, "ACCEPTANCE_WINDOW");
}

/** A paid, delivered order in its acceptance window, with a signed-in seller page to act on it. */
export async function deliveredOrder(browser: Browser, page: Page, request: APIRequestContext) {
  const { orderId, listing } = await buyListing(page, request, "sample-listing-live-tier-a");
  const sellerContext = await browser.newContext();
  const seller = await sellerContext.newPage();
  await signInAs(sellerContext, USERS.seller);
  await sellerConfirms(seller, orderId);
  await deliver(request, orderId);
  return { orderId, listing, seller, sellerContext };
}
