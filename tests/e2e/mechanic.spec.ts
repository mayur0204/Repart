import { expect, test } from "@playwright/test";
import { waitForOrderState } from "./support/data";
import { waitForRow } from "./support/db";
import { BUCKETS } from "./support/env";
import { expectNoAxeViolations, gotoReady, signInAs, USERS } from "./support/fixtures";
import { testPhoto } from "./support/images";
import { expectSignedPrivateImage } from "./support/storage";
import { buyListing, sellerConfirms } from "./support/journeys";

/**
 * Partner Check journey (PLAN.md M10): a Tier C part is bought → the seller confirms with a Partner Check slot → the
 * sample garage's mechanic sees the job, takes the required Front/Back/Side photos (uploaded for real to the private
 * inspection-photos bucket in the Supabase development project), answers the checklist and submits PASS_WITH_NOTES.
 * The order moves on to INSPECTION_PASSED and the listing gets the Partner Check label.
 */
test("a required Partner Check: the mechanic photographs, inspects and passes the part", async ({ browser, page, request }, info) => {
  test.setTimeout(240_000); // several actors, real uploads and the worker in one journey
  const { orderId } = await buyListing(page, request, "sample-listing-live-tier-c");

  const sellerContext = await browser.newContext();
  const seller = await sellerContext.newPage();
  await signInAs(sellerContext, USERS.seller);
  await sellerConfirms(seller, orderId);
  await waitForOrderState(orderId, "INSPECTION_SCHEDULED");
  const job = await waitForRow<{ id: string }>(`SELECT id FROM "Inspection" WHERE "orderId" = $1`, [orderId]);
  await sellerContext.close();

  const mechContext = await browser.newContext();
  const mech = await mechContext.newPage();
  await signInAs(mechContext, USERS.mechanic);
  await gotoReady(mech, "/mechanic");
  await expect(mech.getByRole("heading", { name: "Jobs", level: 1 })).toBeVisible();
  await expectNoAxeViolations(mech);
  await mech.locator(`a[href="/mechanic/jobs/${job.id}"]`).first().click();
  await expect(mech).toHaveURL(new RegExp(`/mechanic/jobs/${job.id}$`));
  await expectNoAxeViolations(mech);

  await gotoReady(mech, `/mechanic/jobs/${job.id}/inspect`);
  await expect(mech.getByRole("heading", { name: "Inspection", level: 1 })).toBeVisible();
  await expectNoAxeViolations(mech);

  const fillForm = async () => {
    const checks = mech.locator('main select[name^="check_"]');
    for (let i = 0; i < (await checks.count()); i++) await checks.nth(i).selectOption("yes");
    await mech.getByLabel("Outcome").selectOption("PASS_WITH_NOTES");
    await mech.getByLabel(/^Notes/).fill("SAMPLE e2e: pads have 3 mm left, light glazing on one edge.");
  };

  // An empty form says what's missing.
  await mech.getByRole("button", { name: "Submit inspection" }).click();
  await expect(mech.getByText("Choose the outcome.").first()).toBeVisible();
  await expect(mech.getByText("Answer this question.").first()).toBeVisible();

  // A complete form without the required photos is refused and says why.
  await fillForm();
  await mech.getByRole("button", { name: "Submit inspection" }).click();
  await expect(mech.getByText(/Add the required photos first \(3 missing\)/)).toBeVisible();

  for (const shot of ["Front", "Back", "Side view"]) {
    const slot = mech.locator("main ul > li").filter({ has: mech.getByText(shot, { exact: true }) }).first();
    await slot.locator('input[type="file"]').setInputFiles(await testPhoto(`inspection-${info.project.name}-${shot}`));
    await expect(slot.getByText("Added")).toBeVisible({ timeout: 60_000 });
  }
  await expectSignedPrivateImage(request, (await mech.getByRole("img", { name: "Front" }).getAttribute("src"))!, BUCKETS.inspection);

  await mech.reload(); // the photos refresh the page; start the form again from a clean state
  await mech.waitForLoadState("networkidle");
  await fillForm();
  await expectNoAxeViolations(mech);
  await mech.getByRole("button", { name: "Submit inspection" }).click();
  await expect(mech).toHaveURL(new RegExp(`/mechanic/jobs/${job.id}$`));
  await expect(mech.getByText("Passed with notes").first()).toBeVisible();
  // A pass moves the order on; with the seller's preferred pickup slot already chosen, the courier is booked at once.
  await waitForRow(`SELECT 1 FROM "OrderEvent" WHERE "orderId" = $1 AND "toState" = 'INSPECTION_PASSED'`, [orderId]);
  await waitForOrderState(orderId, "PICKUP_SCHEDULED");
  const done = await waitForRow<{ status: string; outcome: string; photos: string }>(
    `SELECT i.status, i.outcome, (SELECT count(*) FROM "InspectionPhoto" p WHERE p."inspectionId" = i.id AND p."storageKey" IS NOT NULL AND p."incomingKey" IS NULL) AS photos FROM "Inspection" i WHERE i.id = $1 AND i.status = 'COMPLETED'`,
    [job.id],
  );
  expect(done).toEqual({ status: "COMPLETED", outcome: "PASS_WITH_NOTES", photos: "3" });
  await mechContext.close();
});

test("the mechanic sees the seeded completed inspection in history", async ({ page }) => {
  await signInAs(page.context(), USERS.mechanic);
  await gotoReady(page, "/mechanic/history");
  await expectNoAxeViolations(page);
});

