import { expect, test } from "@playwright/test";
import { one, waitForRow } from "./support/db";
import { expectNoAxeViolations, gotoReady, signInAs, USERS } from "./support/fixtures";

/** Admin journey (PLAN.md M12): every admin area loads, passes axe, and the users page can suspend and restore. */
const PAGES = [
  { path: "/admin", heading: "Admin" },
  { path: "/admin/orders", heading: "Orders" },
  { path: "/admin/orders/sample-order-disputed", heading: null },
  { path: "/admin/disputes", heading: "Disputes" },
  { path: "/admin/reports", heading: "Reports" },
  { path: "/admin/users", heading: "Users" },
  { path: "/admin/agreement", heading: "Agreement" },
  { path: "/admin/export", heading: "Training-data export" },
  { path: "/admin/audit", heading: "Audit log" },
];

test.describe("admin", () => {
  test.beforeEach(async ({ context }) => signInAs(context, USERS.admin));

  for (const p of PAGES) {
    test(`${p.path} loads and passes axe`, async ({ page }) => {
      await gotoReady(page, p.path);
      if (p.heading) await expect(page.getByRole("heading", { name: p.heading, level: 1 })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
      await expectNoAxeViolations(page);
    });
  }

  test("orders can be searched and filtered", async ({ page }) => {
    await gotoReady(page, "/admin/orders?q=sample-order-disputed");
    await expect(page.locator('a[href="/admin/orders/sample-order-disputed"]')).toBeVisible();
    await gotoReady(page, "/admin/orders?q=sample-order-disputed&state=COMPLETED");
    await expect(page.locator('a[href="/admin/orders/sample-order-disputed"]')).toHaveCount(0);
  });

  test("the training-data CSV downloads with the fixed header and is audited once per download", async ({ page }) => {
    const before = Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "AuditLog" WHERE action = 'export.training_data'`))!.n);
    await gotoReady(page, "/admin/export"); // viewing the page must not start (or audit) an export
    const res = await page.request.get("/api/admin/export/training.csv");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect((await res.text()).split("\r\n")[0]).toMatch(/^listing_id,listing_status,/);
    expect(Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "AuditLog" WHERE action = 'export.training_data'`))!.n)).toBe(before + 1);
  });

  test("suspending a user ends their session; restoring lets them back in", async ({ page, browser }) => {
    const memberContext = await browser.newContext();
    const member = await memberContext.newPage();
    await signInAs(memberContext, USERS.buyer2);
    await gotoReady(member, "/account");
    await expect(member.getByRole("heading", { name: "Account" })).toBeVisible();

    await gotoReady(page, `/admin/users/${USERS.buyer2}`);
    await expectNoAxeViolations(page);
    await page.getByLabel("Reason (recorded in the audit log)").fill("SAMPLE e2e suspension check");
    await page.getByRole("button", { name: "Suspend account" }).click();
    await waitForRow(`SELECT 1 FROM "User" WHERE id = $1 AND status = 'SUSPENDED'`, [USERS.buyer2]);

    await member.goto("/account");
    await expect(member).toHaveURL(/\/sign-in/); // the suspended session no longer resolves

    await gotoReady(page, `/admin/users/${USERS.buyer2}`);
    await page.getByLabel("Reason (recorded in the audit log)").fill("SAMPLE e2e restore");
    await page.getByRole("button", { name: "Restore account" }).click();
    await waitForRow(`SELECT 1 FROM "User" WHERE id = $1 AND status = 'ACTIVE'`, [USERS.buyer2]);
    await signInAs(memberContext, USERS.buyer2);
    await member.goto("/account");
    await expect(member.getByRole("heading", { name: "Account" })).toBeVisible();
    await memberContext.close();
  });
});

/** Permission-denied paths for each role, and signed-out access (PLAN.md §10). */
test.describe("permissions", () => {
  const denied = "You don't have access to this page";

  test("signed-out visitors are sent to sign in for member and admin areas", async ({ page }) => {
    for (const path of ["/account", "/admin", "/seller", "/sell", "/messages", "/garage"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/sign-in\?next=/);
    }
    for (const path of ["/orders", "/mechanic"]) {
      await page.goto(path);
      await expect(page.getByRole("link", { name: /sign in/i }).first().or(page.getByLabel("Mobile number")), path).toBeVisible();
    }
    expect((await page.request.get("/api/admin/export/training.csv")).status()).toBe(401);
  });

  test("members can't open admin or mechanic pages", async ({ page }) => {
    await signInAs(page.context(), USERS.buyer);
    for (const path of ["/admin", "/admin/users", "/admin/audit", "/mechanic"]) {
      await page.goto(path);
      await expect(page.getByText(denied), path).toBeVisible();
    }
    await expectNoAxeViolations(page);
    expect((await page.request.get("/api/admin/export/training.csv")).status()).toBe(403);
  });

  test("mechanics can't open admin pages; buyers can't open another member's order", async ({ page, browser }) => {
    await signInAs(page.context(), USERS.mechanic);
    await page.goto("/admin");
    await expect(page.getByText(denied)).toBeVisible();

    const other = await browser.newContext();
    const p2 = await other.newPage();
    await signInAs(other, USERS.buyer2);
    // Someone else's order looks exactly like a missing one: a real 404.
    const res = await p2.goto("/orders/sample-order-completed");
    expect(res?.status()).toBe(404);
    await expect(p2.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(p2.getByText("SAMPLE front wheel")).toHaveCount(0);
    await other.close();
  });
});
