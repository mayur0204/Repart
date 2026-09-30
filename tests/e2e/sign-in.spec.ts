import { expect, test } from "@playwright/test";
import { one } from "./support/db";
import { expectNoAxeViolations, gotoReady } from "./support/fixtures";

/**
 * Sign-in journey (PLAN.md M2 "e2e sign-in on both widths"): phone → mock OTP (000000) → about you + consent →
 * skip add bike → signed in → sign out. A new, never-used number in the local test database only; the mock OTP
 * provider never sends anything.
 */
test("a new member signs in with a code, gives consent, skips adding a bike and signs out", async ({ page }, info) => {
  const phone = `9${String(Date.now()).slice(-8)}${info.project.name === "mobile-375" ? 1 : 2}`;
  await gotoReady(page, "/sign-in?next=/garage");
  await expectNoAxeViolations(page);
  await page.getByLabel("Mobile number").fill(phone);
  await page.getByRole("button", { name: "Send code" }).click();

  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await page.getByLabel("Code").fill("123456");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /code/i }).first()).toBeVisible(); // wrong code: says what happened, stays on the page
  await expect(page.getByLabel("Code")).toHaveValue(""); // React resets the form after the action returns
  await page.getByLabel("Code").fill("000000");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "About you" })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole("textbox", { name: "Your name" }).fill("E2E Member");
  await page.getByRole("button", { name: "Agree and continue" }).click();

  await expect(page.getByRole("heading", { name: "Add your bike" })).toBeVisible();
  await page.getByRole("link", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/\/garage$/);

  const user = await one<{ id: string }>(`SELECT id FROM "User" WHERE phone = $1`, [`+91${phone}`]);
  expect(user).toBeDefined();
  expect(await one(`SELECT 1 FROM "ConsentRecord" WHERE "userId" = $1 LIMIT 1`, [user!.id])).toBeDefined();

  await gotoReady(page, "/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/account");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount/);
});

test("sample (reserved-range) numbers are refused by a production build", async ({ page }) => {
  await gotoReady(page, "/sign-in");
  await page.getByLabel("Mobile number").fill("5555500005");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText(/mobile number/i).first()).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
});
