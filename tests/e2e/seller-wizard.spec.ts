import { expect, test, type Page } from "@playwright/test";
import { one, waitForRow } from "./support/db";
import { BUCKETS } from "./support/env";
import { expectNoAxeViolations, gotoReady, signInAs, USERS } from "./support/fixtures";
import { testPhoto } from "./support/images";
import { expectSignedPrivateImage } from "./support/storage";

/**
 * Listing wizard with real photos (PLAN.md M4, M5): bike → part number → condition → photos → details → price →
 * review → submit. Photos go browser → signed upload URL → private listing-photos bucket (Supabase development
 * project) → worker (EXIF strip, measurements) → risk screening, which reads the processed files → LIVE.
 */
async function uploadShot(page: Page, label: string, seed: string) {
  const slot = page.locator("main ul > li").filter({ has: page.getByText(label, { exact: true }) }).first();
  await slot.locator('input[type="file"]').setInputFiles(await testPhoto(seed));
  await expect(slot.getByText("Replace photo")).toBeVisible({ timeout: 60_000 }); // uploaded and registered
  await expect(slot.getByRole("alert")).toHaveCount(0); // no on-device quality warning
}

test("seller lists a part with real photos; it's screened and goes live with private, signed photos", async ({ page, request }, info) => {
  test.setTimeout(240_000); // real uploads plus the worker's processing and screening
  await signInAs(page.context(), USERS.seller);
  await gotoReady(page, "/sell");
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Start a new listing" }).click();
  await page.waitForURL(/\/sell\/[^/]+\/bike$/);
  await page.waitForLoadState("networkidle");
  const listingId = page.url().match(/\/sell\/([^/]+)\//)![1]!;

  // 1. Bike: this seller has no garage bikes, so one is picked from the catalogue.
  await page.getByLabel("Make").selectOption({ label: "Sample Motors" });
  for (const field of ["Model", "Variant", "Year"]) {
    await expect(page.getByLabel(field)).toBeEnabled();
    await page.getByLabel(field).selectOption({ index: 1 });
  }
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 2. Part number.
  await page.waitForURL(/\/part$/);
  await page.waitForLoadState("networkidle");
  await page.locator("#pn").fill("SAMPLE-MIR-0001");
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByLabel("Part name").fill("SAMPLE e2e right mirror");
  await page.waitForLoadState("networkidle");
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 3. Condition checklist. The radios are visually hidden inside their labels, so click the labels like a user does.
  await page.waitForURL(/\/condition$/);
  await page.waitForLoadState("networkidle");
  const groups = page.locator("main ol fieldset");
  for (let i = 0; i < (await groups.count()); i++) await groups.nth(i).getByText("No", { exact: true }).click();
  for (const text of await page.getByText(/can't be listed, for safety/).allInnerTexts()) {
    const q = text.match(/“(.+)”/)?.[1];
    if (q) await page.getByRole("group", { name: q }).getByText("Yes", { exact: true }).click();
  }
  await expect(page.getByText(/^Grade: /)).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 4. Photos: the three required shots for mirrors, uploaded for real and processed by the worker.
  await page.waitForURL(/\/photos$/);
  await page.waitForLoadState("networkidle");
  for (const shot of ["Front", "Back", "Mount"]) await uploadShot(page, shot, `listing-${info.project.name}-${shot}`);
  await expect(page.getByText(/^3 of at least 3 photos ready/)).toBeVisible({ timeout: 90_000 });
  const processed = await one<{ n: string; clean: string }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE "incomingKey" IS NULL AND "storageKey" IS NOT NULL AND width >= 800 AND "blurScore" IS NOT NULL) AS clean FROM "ListingPhoto" WHERE "listingId" = $1`,
    [listingId],
  );
  expect(processed).toEqual({ n: "3", clean: "3" }); // originals deleted, clean files stored and measured
  await expectSignedPrivateImage(request, (await page.locator("main ul > li img").first().getAttribute("src"))!, BUCKETS.listing);
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Continue" }).click();

  // 5. Details.
  await page.waitForURL(/\/details$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Description").fill("SAMPLE e2e listing: right mirror removed from a working bike, glass and stem intact, light scuffs on the housing.");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 6. Price and pickup.
  await page.waitForURL(/\/price$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Price (₹)").fill("600");
  await page.getByLabel("Packed weight").selectOption({ index: 1 });
  await page.getByLabel("Packed size").selectOption({ index: 1 });
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 7. Review and submit; risk screening runs in the worker.
  await page.waitForURL(/\/review$/);
  await page.waitForLoadState("networkidle");
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Submit listing" }).click();
  const assessed = await waitForRow<{ routingDecision: string; hadHardFailure: boolean; status: string }>(
    `SELECT r."routingDecision", r."hadHardFailure", l.status FROM "RiskAssessment" r JOIN "Listing" l ON l.id = r."listingId" WHERE r."listingId" = $1 AND l.status <> 'SCREENING' AND l.status <> 'SUBMITTED'`,
    [listingId],
    120_000,
  );
  expect(assessed).toEqual({ routingDecision: "LIVE", hadHardFailure: false, status: "LIVE" });

  // The public page shows the processed photos through signed URLs, with alt text from the shot type.
  await gotoReady(page, `/listings/${listingId}`);
  const img = page.getByRole("img", { name: /SAMPLE e2e right mirror: / }).first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  await expectSignedPrivateImage(request, (await img.getAttribute("src"))!, BUCKETS.listing);
  await expectNoAxeViolations(page);
});

test("the review step blocks submission until the required photos are in", async ({ page }) => {
  await signInAs(page.context(), USERS.seller);
  await gotoReady(page, "/sell");
  await page.getByRole("button", { name: "Start a new listing" }).click();
  await page.waitForURL(/\/sell\/[^/]+\/bike$/);
  const listingId = page.url().match(/\/sell\/([^/]+)\//)![1]!;
  await gotoReady(page, `/sell/${listingId}/review`);
  await expect(page.getByText(/Add at least \d+ photos/).first()).toBeVisible();
  await expectNoAxeViolations(page);
});
