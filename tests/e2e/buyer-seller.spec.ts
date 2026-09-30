import { expect, test } from "@playwright/test";
import { copyListing, orderFor, waitForOrderState } from "./support/data";
import { one, waitForRow, withDb } from "./support/db";
import { expectNoAxeViolations, gotoReady, payViaMockWebhook, signInAs, trackingEvent, USERS } from "./support/fixtures";

/**
 * Buyer and seller journey (PLAN.md M6, M8, M9, M11): search → listing detail with fit bar → checkout with the mock
 * payment provider → seller confirms with a pickup slot → courier tracking webhooks → delivered → acceptance window →
 * buyer confirms it's OK → both sides leave a review.
 *
 * The mock provider's hosted payment page only exists in development builds, so the test does what the provider
 * does after a buyer pays: it sends the signed payment webhook.
 */
test("buyer buys a part, seller ships it, buyer accepts and both review", async ({ browser, page, request }) => {
  test.setTimeout(180_000); // several actors and the worker in one journey
  const listing = await copyListing("sample-listing-live-tier-a");
  await signInAs(page.context(), USERS.buyer);

  await page.goto(`/search?q=${encodeURIComponent(listing.title)}`);
  await expectNoAxeViolations(page);
  await page.getByRole("link", { name: listing.title }).first().click();
  await expect(page.getByRole("heading", { name: listing.title, level: 1 })).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByRole("link", { name: "Buy now" }).first().click();
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: /^Pay / }).click();
  await page.waitForURL(/\/dev\/mock-checkout\//);
  const order = await orderFor(listing.id);
  expect(order.state).toBe("CREATED");
  await payViaMockWebhook(request, order.id, order.totalPaise);
  await waitForOrderState(order.id, "AWAITING_SELLER");

  await page.goto(`/orders/${order.id}`);
  await expectNoAxeViolations(page);

  // Seller confirms with a pickup slot; the worker books the courier.
  const sellerContext = await browser.newContext();
  const seller = await sellerContext.newPage();
  await signInAs(sellerContext, USERS.seller);
  await gotoReady(seller, `/seller/orders/${order.id}`);
  await expectNoAxeViolations(seller);
  await seller.getByRole("button", { name: "Confirm order" }).click();
  await expect(seller.getByRole("button", { name: "Confirm order" })).toBeHidden({ timeout: 30_000 });
  await waitForOrderState(order.id, "PICKUP_SCHEDULED");
  const shipment = await waitForRow<{ providerRef: string }>(`SELECT "providerRef" FROM "Shipment" WHERE "orderId" = $1 AND "providerRef" IS NOT NULL`, [order.id]);

  for (const status of ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"] as const) await trackingEvent(request, shipment.providerRef, status);
  await waitForOrderState(order.id, "ACCEPTANCE_WINDOW");

  // Buyer accepts within the window.
  await gotoReady(page, `/orders/${order.id}`);
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Confirm it's OK" }).click();
  await waitForOrderState(order.id, "COMPLETED");

  await gotoReady(page, `/orders/${order.id}/review`);
  await page.getByLabel(/How was/).selectOption("5");
  await page.getByRole("button", { name: "Submit review" }).click();
  await expect(page.getByText(/You rated .* 5 out of 5/)).toBeVisible();

  await gotoReady(seller, `/orders/${order.id}/review`);
  await seller.getByLabel(/How was/).selectOption("4");
  await seller.getByRole("button", { name: "Submit review" }).click();
  await expect(seller.getByText(/You rated .* 4 out of 5/)).toBeVisible();
  expect(Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "Review" WHERE "orderId" = $1`, [order.id]))!.n)).toBe(2);
  await sellerContext.close();
});

/** Every fit bar state from seeded data, plus two fixture fitments for the states the seed doesn't reach. */
test.describe("fit bar states", () => {
  const cases = [
    { state: "NO_VEHICLE", listing: "sample-listing-live-tier-a", query: "", text: "Add your bike to check fit" },
    { state: "FITS", listing: "sample-listing-live-tier-c", query: "?vehicle=sample-variant-street-150-std&year=2018", text: "Fits your Sample Motors Street 150 Standard (2018)" },
    { state: "SELLER_SAYS", listing: "sample-listing-live-tier-b-optional", query: "?vehicle=sample-variant-city-125-std&year=2017", text: "Seller says this fits your City 125" },
    { state: "UNKNOWN", listing: "sample-listing-live-pickup-nopayout", query: "?vehicle=sample-variant-street-150-std&year=2018", text: "No fit information for your Street 150 yet" },
    { state: "MODIFICATION", listing: "sample-listing-live-tier-a", query: "?vehicle=sample-variant-city-125-std&year=2017", text: "Fits your City 125 with a modification" },
    { state: "NOT_FIT", listing: "sample-listing-live-tier-a", query: "?vehicle=sample-variant-street-150-std&year=2018", text: "Does not fit your Street 150" },
  ];

  test.beforeAll(async () => {
    await withDb(async (c) => {
      // MODIFICATION: the part's FITS_WITH_MODIFICATION partner (SAMPLE-MIR-0003) fits the City 125.
      await c.query(`INSERT INTO "Fitment" (id, "partNumberId", "variantId", source, "isSample") VALUES ('e2e-fit-mod', 'sample-pn-mir-0003', 'sample-variant-city-125-std', 'PART_NUMBER_MATCH', true) ON CONFLICT (id) DO NOTHING`);
      // NOT_FIT: a mechanic recorded that this listing does not fit the Street 150.
      await c.query(`INSERT INTO "Fitment" (id, "listingId", "variantId", source, verdict, "isSample") VALUES ('e2e-fit-notfit', 'sample-listing-live-tier-a', 'sample-variant-street-150-std', 'MECHANIC_CONFIRMED', 'DOES_NOT_FIT', true) ON CONFLICT (id) DO NOTHING`);
    });
  });

  for (const c of cases) {
    test(`${c.state}: text and icon, never colour alone`, async ({ page }) => {
      await page.goto(`/listings/${c.listing}${c.query}`);
      const bar = page.getByText(c.text).first();
      await expect(bar).toBeVisible();
      // The bar pairs its headline with an icon (brief §10 "never colour alone").
      await expect(page.locator("section, div").filter({ has: bar }).locator("svg").first()).toBeAttached();
      await expectNoAxeViolations(page);
    });
  }
});
