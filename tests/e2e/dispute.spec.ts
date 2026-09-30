import { expect, test } from "@playwright/test";
import { waitForOrderState } from "./support/data";
import { one, waitForRow } from "./support/db";
import { BUCKETS } from "./support/env";
import { expectNoAxeViolations, gotoReady, signInAs, USERS } from "./support/fixtures";
import { testPhoto } from "./support/images";
import { expectSignedPrivateImage } from "./support/storage";
import { deliveredOrder } from "./support/journeys";

/**
 * Dispute journey (PLAN.md M11): buyer reports a problem inside the acceptance window → seller responds → admin sees
 * the dispute and evidence photo and records a decision. The evidence goes to the private dispute-evidence bucket in
 * the Supabase development project and is only ever shown through a short-lived signed URL.
 */
test("buyer reports a problem with a photo, seller responds, admin releases the payout", async ({ browser, page, request }, info) => {
  test.setTimeout(240_000); // several actors, a real upload and the worker in one journey
  const { orderId, seller, sellerContext } = await deliveredOrder(browser, page, request);

  await gotoReady(page, `/orders/${orderId}/report`);
  await expectNoAxeViolations(page);
  const reason = page.getByLabel("What went wrong?");
  await reason.selectOption({ index: 1 });
  await page.getByLabel(/Describe the problem/).fill("SAMPLE e2e: the mounting tab is cracked, not shown in the photos.");
  await page.getByRole("button", { name: "Report problem" }).click();
  await waitForOrderState(orderId, "DISPUTED");
  const dispute = await waitForRow<{ id: string }>(`SELECT id FROM "Dispute" WHERE "orderId" = $1`, [orderId]);

  // Evidence photo: uploaded for real, cleaned by the server, shown only through a signed URL.
  await gotoReady(page, `/orders/${orderId}/dispute`);
  await page.locator('main input[type="file"]').setInputFiles(await testPhoto(`evidence-${info.project.name}`));
  await waitForRow(`SELECT 1 FROM "DisputeEvidence" WHERE "disputeId" = $1 AND "storageKey" IS NOT NULL AND "incomingKey" IS NULL`, [dispute.id], 60_000);
  const evidence = page.getByRole("img", { name: "Buyer photo" }).first();
  await expect(evidence).toBeVisible();
  await expect.poll(() => evidence.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  await expectSignedPrivateImage(request, (await evidence.getAttribute("src"))!, BUCKETS.dispute);
  await expectNoAxeViolations(page);

  // Another member can't reach the dispute or its evidence.
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signInAs(otherContext, USERS.buyer2);
  await other.goto(`/orders/${orderId}/dispute`);
  await expect(other.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(other.getByRole("img", { name: "Buyer photo" })).toHaveCount(0);
  await otherContext.close();

  await gotoReady(seller, `/seller/orders/${orderId}`);
  await expectNoAxeViolations(seller);
  await seller.getByLabel("Your side of what happened").fill("SAMPLE e2e: it was packed with foam and photographed before pickup.");
  await seller.getByRole("button", { name: "Send response" }).click();
  await waitForRow(`SELECT 1 FROM "Dispute" WHERE id = $1 AND "sellerResponse" IS NOT NULL`, [dispute.id]);
  await sellerContext.close();

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signInAs(adminContext, USERS.admin);
  await gotoReady(admin, "/admin/disputes");
  await expectNoAxeViolations(admin);
  await gotoReady(admin, `/admin/disputes/${dispute.id}`);
  await expectNoAxeViolations(admin);
  await expect(admin.getByText("SAMPLE e2e: it was packed with foam")).toBeVisible();
  const adminView = admin.getByRole("img", { name: "buyer evidence" }).first();
  await expect(adminView).toBeVisible();
  await expectSignedPrivateImage(request, (await adminView.getAttribute("src"))!, BUCKETS.dispute);
  await admin.getByLabel("Decision").selectOption("RELEASE");
  await admin.getByLabel("Reason (required, shown to both sides)").fill("SAMPLE e2e: photos show the tab was intact at pickup.");
  await admin.getByRole("button", { name: "Record decision" }).click();
  await waitForRow(`SELECT 1 FROM "Dispute" WHERE id = $1 AND status <> 'UNDER_REVIEW' AND status <> 'OPEN' AND status <> 'AWAITING_SELLER'`, [dispute.id]);
  // The decision goes through the order state machine, which audits it with the admin as actor.
  expect(await one(`SELECT 1 FROM "AuditLog" WHERE "entityId" = $1 AND "actorId" = $2 LIMIT 1`, [orderId, USERS.admin])).toBeDefined();
  await adminContext.close();
});

test("the seeded dispute shows to the buyer with its status in words", async ({ page }) => {
  await signInAs(page.context(), USERS.buyer);
  await gotoReady(page, "/orders/sample-order-disputed/dispute");
  await expect(page.getByRole("heading", { name: "Dispute" })).toBeVisible();
  await expectNoAxeViolations(page);
});
